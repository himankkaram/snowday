/*
 * Snow Day board controller — ESP32 + ADXL345 or MPU-6050 accelerometer, USB serial.
 * The sensor type is detected automatically at start-up.
 *
 * STATUS: compiles for ESP32 (core 3.3.12); not yet run on hardware. Test it with the
 * sequence in docs/HARDWARE.md before relying on it.
 *
 * Arduino IDE setup:
 *   Boards Manager: install "esp32 by Espressif Systems"; select "ESP32 Dev Module".
 *   No extra libraries needed: talks to the sensor directly over I2C with Wire.
 *
 * Wiring (classic ESP32 DevKit pin numbers; check your board's pinout):
 *   Sensor VCC -> 3V3      Sensor GND -> GND
 *   Sensor SDA -> GPIO 21  Sensor SCL -> GPIO 22
 *   ADXL345 only: CS -> 3V3 (selects I2C mode), SDO -> GND (address 0x53)
 *   Grove buzzer instead of a motor: SIG -> GPIO 25, VCC -> 3V3, GND -> GND
 *   LED: GPIO 4 -> 220 ohm resistor -> LED long leg; LED short leg -> GND
 *   Vibration: GPIO 25 -> IN/SIG of a vibration MOTOR MODULE (has its own transistor),
 *              module VCC -> 3V3 (or 5V if the module says so), module GND -> GND.
 *   NEVER wire a bare motor straight to a GPIO pin. See docs/HARDWARE.md for the
 *   transistor + diode circuit if you only have a bare motor.
 *
 * Serial protocol (115200 baud, newline-terminated) — must match shared/protocol.ts:
 *   board -> host:  S,<steer -1..1>   ~50/s
 *                   I,<info text>
 *   host -> board:  H            hit: buzz + flash
 *                   L,<effect>   off | idle | warn | hit
 *                   C            recalibrate neutral
 */
#include <Wire.h>
#include <math.h>

// ---------- pins ----------
const int PIN_SDA = 21;
const int PIN_SCL = 22;
const int PIN_LED = 4;
const int PIN_MOTOR = 25;

// ---------- tuning ----------
const bool USE_ROLL = true;        // true: steer from rotation about the X axis; false: Y axis
const bool INVERT = false;         // flip if leaning left steers right
const float MAX_TILT_DEG = 12.0;   // tilt that gives full lock; a low board only rocks ~10-15 deg
const float DEADZONE = 0.08;       // ignore wobble within 8% of full lock
const float FILTER_ALPHA = 0.2;    // low-pass at 100 Hz sampling; lower = smoother but laggier
const unsigned long SAMPLE_MS = 10;   // 100 Hz sensor reads
const unsigned long SEND_MS = 20;     // 50 Hz serial output
const unsigned long HIT_MS = 250;     // buzz length per hit
const unsigned long MAX_BUZZ_MS = 1500; // safety cap on continuous buzzing

// ---------- state ----------
float neutralDeg = 0;
float filteredDeg = 0;
bool sensorOk = false;
unsigned long lastSample = 0, lastSend = 0, lastSensorRetry = 0;
unsigned long hitUntil = 0, buzzStartedAt = 0;
String ledEffect = "off";
String inbox;

// ---------- accelerometer (auto-detects ADXL345 or MPU-6050) ----------
enum SensorType { SENSOR_NONE, SENSOR_ADXL345, SENSOR_MPU6050 };
SensorType sensorType = SENSOR_NONE;
uint8_t sensorAddr = 0;

bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool regWrite(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

int regRead(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)addr, 1) != 1) return -1;
  return Wire.read();
}

bool sensorInit() {
  sensorType = SENSOR_NONE;
  // ADXL345: 0x53 when SDO is low (usual), 0x1D when SDO is high. DEVID register 0x00 reads 0xE5.
  const uint8_t adxlAddrs[] = {0x53, 0x1D};
  for (uint8_t a : adxlAddrs) {
    if (i2cPresent(a) && regRead(a, 0x00) == 0xE5) {
      regWrite(a, 0x31, 0x08);  // DATA_FORMAT: full resolution, +-2 g
      regWrite(a, 0x2C, 0x0A);  // BW_RATE: 100 Hz
      regWrite(a, 0x2D, 0x08);  // POWER_CTL: start measuring
      sensorType = SENSOR_ADXL345;
      sensorAddr = a;
      Serial.printf("I,sensor ADXL345 found at 0x%02X\n", a);
      return true;
    }
  }
  // MPU-6050: 0x68, or 0x69 if AD0 is tied high.
  const uint8_t mpuAddrs[] = {0x68, 0x69};
  for (uint8_t a : mpuAddrs) {
    if (i2cPresent(a) && regWrite(a, 0x6B, 0x00)) {  // PWR_MGMT_1: wake up
      regWrite(a, 0x1C, 0x00);                        // ACCEL_CONFIG: +-2 g
      regWrite(a, 0x1A, 0x03);                        // CONFIG: on-chip low-pass ~44 Hz
      sensorType = SENSOR_MPU6050;
      sensorAddr = a;
      Serial.printf("I,sensor MPU-6050 found at 0x%02X (WHO_AM_I=0x%02X)\n", a, regRead(a, 0x75));
      return true;
    }
  }
  return false;
}

// Reads acceleration in g. Returns false on I2C failure.
bool readAccel(float &ax, float &ay, float &az) {
  if (sensorType == SENSOR_NONE) return false;
  uint8_t startReg = sensorType == SENSOR_ADXL345 ? 0x32 : 0x3B;
  Wire.beginTransmission(sensorAddr);
  Wire.write(startReg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)sensorAddr, 6) != 6) return false;
  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = Wire.read();
  int16_t rx, ry, rz;
  float lsbPerG;
  if (sensorType == SENSOR_ADXL345) {  // little-endian, 256 LSB/g in full resolution
    rx = (int16_t)(b[1] << 8 | b[0]);
    ry = (int16_t)(b[3] << 8 | b[2]);
    rz = (int16_t)(b[5] << 8 | b[4]);
    lsbPerG = 256.0;
  } else {  // MPU-6050: big-endian, 16384 LSB/g at +-2 g
    rx = (int16_t)(b[0] << 8 | b[1]);
    ry = (int16_t)(b[2] << 8 | b[3]);
    rz = (int16_t)(b[4] << 8 | b[5]);
    lsbPerG = 16384.0;
  }
  ax = rx / lsbPerG;
  ay = ry / lsbPerG;
  az = rz / lsbPerG;
  return true;
}

// Returns tilt in degrees, or NAN on I2C failure.
float readTiltDeg() {
  float ax, ay, az;
  if (!readAccel(ax, ay, az)) return NAN;
  // Gravity-only tilt: fine for a slowly rocking board, no gyro drift to fight.
  // fabs(az) lets the sensor be mounted chip-up OR upside down (under the deck) without the
  // angle wrapping at +-180 deg. If it then steers the wrong way, set INVERT = true.
  float deg = USE_ROLL ? atan2(ay, fabs(az)) * 180.0 / PI
                       : atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  return INVERT ? -deg : deg;
}

void calibrate() {
  // Rider stands still and level. Average ~1 s of readings.
  float sum = 0;
  int n = 0;
  for (int i = 0; i < 100; i++) {
    float d = readTiltDeg();
    if (!isnan(d)) { sum += d; n++; }
    delay(10);
  }
  if (n > 50) {
    neutralDeg = sum / n;
    filteredDeg = neutralDeg;
    Serial.printf("I,calibrated neutral=%.2f deg\n", neutralDeg);
  } else {
    Serial.println("I,calibration failed: sensor not answering");
  }
}

// ---------- outputs ----------
void updateOutputs(unsigned long now) {
  bool hitting = now < hitUntil;
  if (hitting && buzzStartedAt == 0) buzzStartedAt = now;
  if (!hitting) buzzStartedAt = 0;
  bool buzzSafe = buzzStartedAt == 0 || now - buzzStartedAt < MAX_BUZZ_MS;
  digitalWrite(PIN_MOTOR, (hitting && buzzSafe) ? HIGH : LOW);

  bool led;
  if (hitting) led = (now / 60) % 2;                 // fast flash during a hit
  else if (ledEffect == "warn") led = (now / 250) % 2;
  else if (ledEffect == "idle") led = (now / 1000) % 2 == 0 && (now % 1000) < 80; // heartbeat
  else if (ledEffect == "hit") led = true;
  else led = false;
  digitalWrite(PIN_LED, led ? HIGH : LOW);
}

void handleCommand(String cmd) {
  cmd.trim();
  if (cmd == "H") {
    hitUntil = millis() + HIT_MS;
  } else if (cmd.startsWith("L,")) {
    String e = cmd.substring(2);
    if (e == "off" || e == "idle" || e == "warn" || e == "hit") ledEffect = e;
  } else if (cmd == "C") {
    calibrate();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);  // motor OFF before anything else
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  delay(200);
  sensorOk = sensorInit();
  if (sensorOk) calibrate();
  else Serial.println("I,no ADXL345/MPU-6050 found: check SDA/SCL/3V3/GND (ADXL345: CS to 3V3)");
}

void loop() {
  unsigned long now = millis();

  // Read commands from the host without blocking.
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { handleCommand(inbox); inbox = ""; }
    else if (inbox.length() < 32) inbox += c;
  }

  if (!sensorOk && now - lastSensorRetry > 1000) {
    lastSensorRetry = now;
    sensorOk = sensorInit();
    if (sensorOk) calibrate();
    else Serial.println("I,no ADXL345/MPU-6050 found: check SDA/SCL/3V3/GND (ADXL345: CS to 3V3)");
  }

  if (sensorOk && now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    float d = readTiltDeg();
    if (isnan(d)) {
      sensorOk = false;  // loose wire: steer goes neutral, retry next second
    } else {
      filteredDeg += (d - filteredDeg) * FILTER_ALPHA;
    }
  }

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    float steer = 0;
    if (sensorOk) {
      steer = (filteredDeg - neutralDeg) / MAX_TILT_DEG;
      float a = fabs(steer);
      steer = a <= DEADZONE ? 0 : (steer > 0 ? 1 : -1) * fmin(1.0, (a - DEADZONE) / (1 - DEADZONE));
    }
    Serial.printf("S,%.3f\n", steer);
  }

  updateOutputs(now);
}
