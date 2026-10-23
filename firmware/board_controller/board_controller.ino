/*
 * Snow Day board controller — ESP32 + MPU-6050 (GY-521 module), USB serial.
 *
 * STATUS: written carefully but NOT compiled or run on hardware yet. Test it with the
 * sequence in docs/HARDWARE.md before relying on it.
 *
 * Arduino IDE setup:
 *   Boards Manager: install "esp32 by Espressif Systems"; select "ESP32 Dev Module".
 *   No extra libraries needed: talks to the MPU-6050 directly over I2C with Wire.
 *
 * Wiring (classic ESP32 DevKit pin numbers; check your board's pinout):
 *   GY-521 VCC -> 3V3      GY-521 GND -> GND
 *   GY-521 SDA -> GPIO 21  GY-521 SCL -> GPIO 22
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
const uint8_t MPU_ADDR = 0x68;     // 0x69 if the module's AD0 pin is tied high
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

// ---------- MPU-6050 ----------
bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuInit() {
  if (!mpuWrite(0x6B, 0x00)) return false;  // PWR_MGMT_1: wake up
  mpuWrite(0x1C, 0x00);                      // ACCEL_CONFIG: +-2 g
  mpuWrite(0x1A, 0x03);                      // CONFIG: on-chip low-pass ~44 Hz
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x75);                          // WHO_AM_I
  Wire.endTransmission(false);
  Wire.requestFrom((int)MPU_ADDR, 1);
  int who = Wire.available() ? Wire.read() : -1;
  Serial.printf("I,sensor WHO_AM_I=0x%02X (0x68 genuine; clones differ, usually fine)\n", who);
  return true;
}

// Returns tilt in degrees, or NAN on I2C failure.
float readTiltDeg() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);  // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0) return NAN;
  if (Wire.requestFrom((int)MPU_ADDR, 6) != 6) return NAN;
  int16_t rx = (Wire.read() << 8) | Wire.read();
  int16_t ry = (Wire.read() << 8) | Wire.read();
  int16_t rz = (Wire.read() << 8) | Wire.read();
  float ax = rx / 16384.0, ay = ry / 16384.0, az = rz / 16384.0;  // in g at +-2 g range
  // Gravity-only tilt: fine for a slowly rocking board, no gyro drift to fight.
  float deg = USE_ROLL ? atan2(ay, az) * 180.0 / PI
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
  sensorOk = mpuInit();
  if (sensorOk) calibrate();
  else Serial.println("I,sensor not found: check SDA/SCL/3V3/GND wiring");
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
    sensorOk = mpuInit();
    if (sensorOk) calibrate();
    else Serial.println("I,sensor not found: check SDA/SCL/3V3/GND wiring");
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
