/*
 * Snow Day board controller: Arduino Mega 2560 + Grove Starter Kit, USB serial.
 * No accelerometer needed: a Grove ROTARY ANGLE SENSOR (knob) sits at the plank's pivot,
 * so tilting the plank turns the knob. Same USB line protocol as the ESP32 version.
 *
 * Arduino IDE: Tools -> Board -> Arduino AVR Boards -> "Arduino Mega or Mega 2560".
 * Processor: ATmega2560. No extra libraries.
 *
 * Wiring (Grove Base Shield on top of the Mega, shield switch set to 5V):
 *   Rotary angle sensor -> A0
 *   Buzzer              -> D3   (hit feedback)
 *   LED                 -> D4   (status / hit flash)
 *   Button  (optional)  -> D2   (press = recalibrate with the plank level)
 *
 * Board -> host (115200 baud, one line each):  S,<steer -1..1>   I,<info>
 * Host -> board:  H (hit)   L,<off|idle|warn|hit>   C (recalibrate)
 */

// ---------- tuning (change these at the event) ----------
const float FULL_TILT_DEG = 12.0;   // plank tilt that gives full steer (1.0)
const float DEADZONE_DEG = 1.5;     // ignore tiny wobbles around level
const float FILTER_ALPHA = 0.3;     // 0..1, lower = smoother but laggier
const bool INVERT = false;          // set true if leaning left steers right
const float KNOB_RANGE_DEG = 300.0; // Grove rotary sensor turns ~300 deg over 0..1023

const int PIN_KNOB = A0;
const int PIN_BUZZER = 3;
const int PIN_LED = 4;
const int PIN_BUTTON = 2;

const unsigned long SEND_EVERY_MS = 20;  // 50 lines per second
const unsigned long HIT_MS = 250;
const unsigned long MAX_BUZZ_MS = 600;   // safety: never buzz longer than this

float neutralDeg = 0;
float filteredDeg = 0;
unsigned long lastSend = 0;
unsigned long hitUntil = 0;
unsigned long buzzStartedAt = 0;
String ledEffect = "idle";
String inbox = "";
bool lastButton = false;

float readKnobDeg() {
  long sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(PIN_KNOB);  // average out ADC noise
  float raw = sum / 8.0;
  return raw * KNOB_RANGE_DEG / 1023.0;
}

void calibrate() {
  // Plank level, nobody leaning. Average ~0.5 s of readings.
  float sum = 0;
  for (int i = 0; i < 50; i++) {
    sum += readKnobDeg();
    delay(10);
  }
  neutralDeg = sum / 50.0;
  filteredDeg = neutralDeg;
  Serial.print("I,calibrated neutral=");
  Serial.print(neutralDeg, 1);
  Serial.println(" deg");
  if (neutralDeg < 20 || neutralDeg > KNOB_RANGE_DEG - 20) {
    Serial.println("I,warning: knob near its end stop, re-mount it nearer the middle");
  }
}

float steerFromDeg(float deg) {
  float d = deg - neutralDeg;
  if (INVERT) d = -d;
  if (fabs(d) < DEADZONE_DEG) return 0;
  d = d > 0 ? d - DEADZONE_DEG : d + DEADZONE_DEG;
  float s = d / (FULL_TILT_DEG - DEADZONE_DEG);
  if (s > 1) s = 1;
  if (s < -1) s = -1;
  return s;
}

void updateOutputs(unsigned long now) {
  bool hitting = now < hitUntil;
  if (hitting && buzzStartedAt == 0) buzzStartedAt = now;
  if (!hitting) buzzStartedAt = 0;
  bool buzzSafe = buzzStartedAt == 0 || now - buzzStartedAt < MAX_BUZZ_MS;
  digitalWrite(PIN_BUZZER, (hitting && buzzSafe) ? HIGH : LOW);

  bool led;
  if (hitting) led = (now / 60) % 2;                    // fast flash during a hit
  else if (ledEffect == "warn") led = (now / 250) % 2;
  else if (ledEffect == "idle") led = (now % 1000) < 80;  // heartbeat
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

void readCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inbox.length()) handleCommand(inbox);
      inbox = "";
    } else if (inbox.length() < 32) {
      inbox += c;
    } else {
      inbox = "";  // junk with no newline: resync
    }
  }
}

void setup() {
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);  // buzzer OFF before anything else
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT);
  Serial.begin(115200);
  delay(200);
  Serial.println("I,Snow Day board (Mega 2560 + knob) starting");
  calibrate();
}

void loop() {
  unsigned long now = millis();
  readCommands();

  bool button = digitalRead(PIN_BUTTON) == HIGH;
  if (button && !lastButton) calibrate();
  lastButton = button;

  float deg = readKnobDeg();
  filteredDeg += FILTER_ALPHA * (deg - filteredDeg);

  if (now - lastSend >= SEND_EVERY_MS) {
    lastSend = now;
    Serial.print("S,");
    Serial.println(steerFromDeg(filteredDeg), 2);
  }
  updateOutputs(now);
}
