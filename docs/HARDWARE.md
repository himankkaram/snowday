# Hardware: board controller

**Status: nothing in this file has been tested on real parts yet.** Work through the validation
sequence in order and tick each step off before moving on.

## Parts

HackNotts says it provides hardware: ask the hardware desk first, since good sensors go early.
Prices are rough UK hobby-shop ranges, not quotes; buying online tonight won't arrive in time.

| Part                       | Minimum spec                                                                                       | ~Cost | Purpose                                  | Alternatives                                                                             | Essential?           |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------- |
| ESP32 dev board            | Classic ESP32 DevKit (WROOM-32), micro-USB or USB-C                                                | £5–10 | Reads sensor, drives outputs, USB serial | Arduino Uno/Nano (sketch needs small pin changes), micro:bit (has its own accelerometer) | Yes                  |
| USB **data** cable         | Data-capable, ≥1 m                                                                                 | £3–5  | Power + serial                           | Charge-only cables are the #1 "board not found" cause                                    | Yes                  |
| MPU-6050 module            | GY-521 breakout, 3.3 V-tolerant                                                                    | £3–6  | Tilt sensing                             | MPU-9250, LSM6DS3 (different registers: code changes)                                    | Yes                  |
| Vibration motor **module** | Has onboard transistor, "IN/SIG" pin, 3.3–5 V                                                      | £2–5  | Hit buzz                                 | Bare coin motor + transistor circuit below                                               | Strongly recommended |
| LED + 220 Ω resistor       | Any 5 mm LED                                                                                       | <£1   | Hit flash                                | WS2812B strip (see upgrade)                                                              | Yes                  |
| Jumper wires, breadboard   | Female-female for GY-521 headers                                                                   | £3–6  | Wiring                                   | Solder                                                                                   | Yes                  |
| Plank + rocker             | Plank ~60–80 cm × 25 cm, ≥15 mm thick; rocker: half pool noodle / rolled towel / 50 mm pipe offcut | £0–10 | Rider platform                           | Sit-down fallback below                                                                  | Yes                  |
| Non-slip mat / grip tape   | —                                                                                                  | £3–8  | Safety                                   | Rubber shelf liner                                                                       | Yes                  |
| Project box / tape         | —                                                                                                  | £0–3  | Protect electronics                      | Duct tape + cardboard                                                                    | Yes                  |

Bare-motor extras if no module: 2N2222 NPN transistor, 1 kΩ resistor, 1N4001 (or 1N4148) diode.

## Wiring (classic ESP32 DevKit; check your board's pin labels)

```
GY-521   VCC ── 3V3        GY-521   GND ── GND
GY-521   SDA ── GPIO 21    GY-521   SCL ── GPIO 22
GPIO 4 ── 220 Ω ── LED long leg (+);  LED short leg (−) ── GND
GPIO 25 ── motor module IN/SIG;  module VCC ── 3V3 (or 5V/VIN if the module requires);  module GND ── GND
```

**Bare coin motor (only if no module):**

```
GPIO 25 ── 1 kΩ ── 2N2222 base
2N2222 emitter ── GND
2N2222 collector ── motor (−)
motor (+) ── 3V3
1N4001 across the motor: stripe (cathode) to motor (+), other end to motor (−)
```

Never power a motor straight from a GPIO pin: a pin can only supply a few tens of mA, and the motor's
back-EMF spikes can reset or damage the ESP32. The diode absorbs the spike. Check the motor's voltage
rating; coin motors are usually 3 V, so 3V3 is right.

Safety: everything here is 3.3–5 V from USB. No mains, no batteries needed, nothing gets hot if wired
as shown. If anything gets warm, unplug and recheck the wiring.

**Optional upgrade, LED strip (not in the firmware yet):** WS2812B needs the Adafruit NeoPixel library,
a 330 Ω resistor on the data line, and power from 5V/VIN. Keep it to ≤10 LEDs at low brightness on USB power.

## Mounting the sensor

Tape or zip-tie the GY-521 flat under the **centre** of the plank, chips facing down or up (either works
after calibration), with its X axis pointing along the plank (nose to tail). Rocking left/right then
rotates about X, which is `USE_ROLL = true` in the sketch. If steering responds to the wrong movement, set
`USE_ROLL = false`; if it's reversed, set `INVERT = true`. Put the ESP32 in a box at one end, cable
taped flat to the floor all the way to the table.

## How steering works

1. Read the accelerometer at 100 Hz; compute tilt from gravity (`atan2`). No gyro, so no drift.
2. Low-pass filter (`FILTER_ALPHA = 0.2`) smooths foot jitter.
3. Subtract the **neutral** angle captured at calibration (rider standing still, board level).
4. Divide by `MAX_TILT_DEG = 12` → −1..1, apply an 8 % deadzone so standing still = exactly 0.
5. Send `S,<value>` at 50 Hz. The host smooths again (80 ms) and adds the keyboard on top.

## Physical platform

- Height under the rider's feet: **a few centimetres max**. Rocking angle ~10–15° is plenty.
- Grip on top, non-slip mat underneath, on a flat floor away from table corners.
- A teammate stands beside the rider every time; a chair back or table edge within reach to hold.
- Shoes on. One rider at a time. No jumping.
- **Sit-down fallback:** rider sits on a chair holding the board on their lap like a tray (or holds the
  ESP32 box with both hands like a steering wheel). Same firmware, same game.

## Validation sequence (tick each off)

Install first: Arduino IDE 2 → Boards Manager → "esp32 by Espressif Systems" → board "ESP32 Dev Module".
Windows/macOS may need the USB-serial driver for your board's chip (CP210x or CH340): check the chip
printed near the USB port.

1. **Board talks:** upload the sketch. Serial Monitor at 115200 shows `I,sensor WHO_AM_I=…` then
   `I,calibrated …` then a stream of `S,0.000`. _Done when:_ lines stream steadily.
   If `sensor not found`: swap SDA/SCL, check 3V3/GND, try `MPU_ADDR = 0x69`.
2. **Raw tilt:** tilt the sensor by hand; `S,` moves toward −1 and +1 and returns to 0 at rest.
3. **Calibrate:** type `C` + Enter in Serial Monitor with the sensor level. _Done when:_ resting value is 0.000.
4. **LED:** type `L,warn` → LED blinks; `L,off` → off.
5. **Hit:** type `H` → LED flashes and motor buzzes ~¼ s. Type `H` 10× quickly → no reset, no reboot messages.
6. **Close Serial Monitor** (only one program can own the port).
7. **Host reads it:** `npm run dev`, open the host page at **localhost** in Chrome, press D for the debug
   overlay, click _Connect board_, pick the port. _Done when:_ overlay shows `serial lines/s ~50` and
   `steer raw` follows the tilt.
8. **Feedback loop:** start a round, throw from a phone with aim on the rider → board buzzes.
9. **Unplug test:** pull the USB cable mid-round. _Done when:_ rider stops drifting (steer 0), keyboard
   still steers, overlay says unplugged. Replug → it reconnects without the port picker (Chrome remembers).
10. **On the plank:** mount, stand on it, recalibrate, tune `MAX_TILT_DEG` so a comfortable lean = full lock.
