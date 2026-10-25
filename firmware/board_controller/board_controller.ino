/*
 * Snow Day board controller
 *
 * This runs on the ESP32 strapped to the skateboard. It reads how far the board
 * is tilted, turns that into a steering number between -1 (full left) and 1
 * (full right), and sends it to the laptop over the USB cable.
 *
 * Works with either an ADXL345 or an MPU-6050 sensor. It figures out which one
 * is plugged in by itself, so you don't need to change anything.
 *
 * To upload: in the Arduino IDE, install "esp32 by Espressif Systems" from the
 * Boards Manager and pick "ESP32 Dev Module". No extra libraries needed.
 *
 * Messages to and from the laptop (one per line, 115200 baud).
 * If you change these, change shared/protocol.ts too or the game stops listening.
 *   We send:     S,<steer>   steering value, about 50 times a second
 *                I,<text>    info for debugging (sensor found, calibrated, etc.)
 *   We receive:  C           recalibrate (rider stands still and balanced first)
 *                The game also sends H (hit) and L,<effect> (LED). This board has no
 *                buzzer or LED, so it ignores them.
 */
#include <Wire.h>
#include <math.h>

const int PIN_SDA = 21;
const int PIN_SCL = 22;

// ---------- Things you'll probably want to tweak while testing ----------

// Which way the sensor is mounted. If tilting the board does nothing much,
// try flipping USE_ROLL. If left steers right, flip INVERT.
const bool USE_ROLL = false;
const bool INVERT = false;

// How many degrees of tilt counts as "full lock". The board only rocks about
// 10-15 degrees, so keep this small or the rider can never turn fully.
const float MAX_TILT_DEG = 12.0;

// Small wobbles from just standing on the board are ignored. 0.08 means the
// first 8% of tilt in either direction does nothing.
const float DEADZONE = 0.08;

// Calibration only accepts a reading this close to level. The board is a seesaw, so with
// nobody on it, it rests tipped onto one end. Calibrating there would make "balanced"
// look like a hard lean and pin the rider to the edge of the screen.
const float CAL_MAX_DEG = 10.0;

// Smoothing. Lower = steadier but slower to react, higher = twitchier.
const float FILTER_ALPHA = 0.2;

const unsigned long SAMPLE_MS = 10;      // read the sensor 100 times a second
const unsigned long SEND_MS = 20;        // send steering 50 times a second

// ---------- Running state ----------
float neutralDeg = 0;   // the tilt reading when the rider is standing level
float filteredDeg = 0;  // smoothed tilt reading
bool sensorOk = false;
unsigned long lastSample = 0, lastSend = 0, lastSensorRetry = 0;
String inbox;  // collects incoming characters until we get a full line

// ---------- Talking to the sensor ----------
// Both sensors use I2C: each chip has an address, and you read or write
// numbered "registers" on it to configure it and get readings.

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

// Looks for either sensor at its usual addresses and switches it on.
bool sensorInit() {
  sensorType = SENSOR_NONE;

  // An ADXL345 always answers 0xE5 when you ask for its ID, so that's how we know it's one.
  const uint8_t adxlAddrs[] = {0x53, 0x1D};
  for (uint8_t a : adxlAddrs) {
    if (i2cPresent(a) && regRead(a, 0x00) == 0xE5) {
      regWrite(a, 0x31, 0x08);  // range +-2 g, which is plenty for tilting
      regWrite(a, 0x2C, 0x0A);  // 100 readings a second
      regWrite(a, 0x2D, 0x08);  // start measuring (it starts asleep)
      sensorType = SENSOR_ADXL345;
      sensorAddr = a;
      Serial.printf("I,sensor ADXL345 found at 0x%02X\n", a);
      return true;
    }
  }

  const uint8_t mpuAddrs[] = {0x68, 0x69};
  for (uint8_t a : mpuAddrs) {
    if (i2cPresent(a) && regWrite(a, 0x6B, 0x00)) {  // wake it up (it starts asleep)
      regWrite(a, 0x1C, 0x00);                        // range +-2 g
      regWrite(a, 0x1A, 0x03);                        // built-in smoothing to cut vibration noise
      sensorType = SENSOR_MPU6050;
      sensorAddr = a;
      Serial.printf("I,sensor MPU-6050 found at 0x%02X (WHO_AM_I=0x%02X)\n", a, regRead(a, 0x75));
      return true;
    }
  }
  return false;
}

// Gets acceleration on each axis in g (1 g = gravity). Returns false if the read fails.
bool readAccel(float &ax, float &ay, float &az) {
  if (sensorType == SENSOR_NONE) return false;
  uint8_t startReg = sensorType == SENSOR_ADXL345 ? 0x32 : 0x3B;
  Wire.beginTransmission(sensorAddr);
  Wire.write(startReg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)sensorAddr, 6) != 6) return false;

  // Each axis comes as 2 bytes. The two chips put the bytes in opposite order
  // and use different scales, which is why there are two branches here.
  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = Wire.read();
  int16_t rx, ry, rz;
  float lsbPerG;
  if (sensorType == SENSOR_ADXL345) {
    rx = (int16_t)(b[1] << 8 | b[0]);
    ry = (int16_t)(b[3] << 8 | b[2]);
    rz = (int16_t)(b[5] << 8 | b[4]);
    lsbPerG = 256.0;
  } else {
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

// Works out the board's tilt in degrees from which way gravity is pulling.
// Returns NAN (not a number) if the sensor didn't answer.
float readTiltDeg() {
  float ax, ay, az;
  if (!readAccel(ax, ay, az)) return NAN;
  // Using fabs(az) means it still works if the sensor is mounted upside down under the deck.
  float deg = USE_ROLL ? atan2(ay, fabs(az)) * 180.0 / PI
                       : atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  return INVERT ? -deg : deg;
}

// Records "level" as whatever the board reads right now, averaged over about
// a second. Have the rider stand still and balanced in the middle, then press C.
// If the board is clearly tipped (e.g. resting on one end), it refuses and keeps the old value.
void calibrate() {
  float sum = 0;
  int n = 0;
  for (int i = 0; i < 100; i++) {
    float d = readTiltDeg();
    if (!isnan(d)) { sum += d; n++; }
    delay(10);
  }
  if (n > 50) {  // only trust it if most readings worked
    float avg = sum / n;
    if (fabs(avg) > CAL_MAX_DEG) {
      Serial.printf("I,calibration skipped: board tipped %.1f deg. Stand level and press C\n", avg);
      return;
    }
    neutralDeg = avg;
    filteredDeg = neutralDeg;
    Serial.printf("I,calibrated neutral=%.2f deg\n", neutralDeg);
  } else {
    Serial.println("I,calibration failed: sensor not answering");
  }
}


// Deals with one line sent from the laptop. Anything we don't recognise
// (like the game's hit and LED messages) is simply ignored.
void handleCommand(String cmd) {
  cmd.trim();
  if (cmd == "C") {
    calibrate();
  }
}

// setup() runs once when the board powers on.
void setup() {
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  delay(200);  // give the sensor a moment to power up
  sensorOk = sensorInit();
  // No automatic calibration here: with nobody on it the board rests tipped onto one end.
  // Start from "level = 0 degrees" (the sensor lies flat on the deck), then press C on the
  // host with the rider balanced to fine-tune.
  if (sensorOk) Serial.println("I,ready: level = 0 deg. Press C with the rider balanced to fine-tune");
  else Serial.println("I,no ADXL345/MPU-6050 found: check SDA/SCL/3V3/GND (ADXL345: CS to 3V3)");
}

// loop() runs over and over forever. Nothing in here waits around, so reading
// the sensor, sending steering and listening to the laptop all happen at once.
void loop() {
  unsigned long now = millis();

  // Collect characters from the laptop until we have a full line, then act on it.
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { handleCommand(inbox); inbox = ""; }
    else if (inbox.length() < 32) inbox += c;
  }

  // If the sensor isn't working (e.g. a wire came loose), try to find it again once a second.
  if (!sensorOk && now - lastSensorRetry > 1000) {
    lastSensorRetry = now;
    sensorOk = sensorInit();
    // Keep the existing calibration: the board could be tipped at any angle right now.
    if (sensorOk) Serial.println("I,sensor back");
    else Serial.println("I,no ADXL345/MPU-6050 found: check SDA/SCL/3V3/GND (ADXL345: CS to 3V3)");
  }

  if (sensorOk && now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    float d = readTiltDeg();
    if (isnan(d)) {
      sensorOk = false;  // lost the sensor: steering goes back to centre until it's found again
    } else {
      // Move the smoothed value a little towards the new reading each time.
      filteredDeg += (d - filteredDeg) * FILTER_ALPHA;
    }
  }

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    float steer = 0;
    if (sensorOk) {
      // How far from level we are, as a fraction of full lock.
      steer = (filteredDeg - neutralDeg) / MAX_TILT_DEG;
      // Ignore tiny wobbles, then stretch the rest so it still goes smoothly from 0 to 1.
      float a = fabs(steer);
      steer = a <= DEADZONE ? 0 : (steer > 0 ? 1 : -1) * fmin(1.0, (a - DEADZONE) / (1 - DEADZONE));
    }
    Serial.printf("S,%.3f\n", steer);
  }
}