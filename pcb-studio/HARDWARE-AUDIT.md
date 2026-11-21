# Rover electrical audit

## Architecture and changes

J6 feeds VIN / AMS1117-3.3 and the nominal 7.4 V motor supply. Two TB6612FNG packages serve four motor terminals J2–J5. J7 has +3V3, SDA and SCL; its nets do not establish a regulated 5 V peripheral supply. Net presence is not proof of correct pin numbering, continuity or routing.

The default battery is now a sourced SparkFun 2200 mAh two-cell series pack (7.4 V nominal, 8.4 V full), not a one-cell holder. Its lack of built-in protection is explicit. 6 V is an assumed system cutoff, not a sourced protection specification. Add a fuse, undervoltage protection, polarity-checked adapter and dedicated 2S balance charger before use. These accessories are not included in the catalog price.

Added Pololu #3040 as a motor alternative; TT motors remain selected so their overvoltage warnings stay visible. Pololu documents operation at 6 V and 12 V, with theoretical stall currents 0.38 A and 0.75 A respectively. It is intended for 12 V: speed/torque at 2S must be validated. Requires different mounts and 3 mm D-shaft wheels. Its voltage/stall screen passes, but assembly compatibility remains unverified. Generic JGA25 estimates no longer produce a safety claim.

Both additions use explicitly estimated $25 budgeting prices, not live quotes. Battery dimensions are inherited placement estimates, not pack dimensions. Cost and alternative deltas use these estimates. Motor `currentMa` is 80 mA no-load, not loaded rover consumption; current deltas must not be used to size the battery. No new dependencies.

## Electrical findings

- TT 3–6 V catalog range does not cover 8.4 V full-charge VM. PWM duty caps alone do not establish safe winding peak current or stall behavior.
- Toshiba's 1.2 A average and 3.2 A peak output ratings are absolute maxima; 3.2 A applies to a single 10 ms pulse. Package dissipation and simultaneous loading matter. The driver is not a programmable current limiter. No safe continuous stall claim is made.
- AMS1117 at 8.4 V to 3.3 V dissipates 1.53 W at an illustrative 300 mA. Actual load, copper, ambient, transient response and regulator identity need validation. Manufacturer PDF retrieval failed; no clone-specific dropout/current guarantee is used.
- HC-SR04 and WS2812 require a separate regulated 5 V path. Sonar echo needs down-translation; LED data needs a specified up-buffer. These are different signal directions. Do not infer 5 V tolerance from ESP32 absolute maximum ratings. Exact generic peripheral manufacturer/revision documentation is missing; no invented thresholds are used.
- Generic OLED/IMU module logic/pull-ups and addresses remain unverified. A catalog supply-voltage fit is not proof of wiring or signal compatibility.
- No complete system is marked safe. `warning` means an identified mismatch; `unverified` means missing evidence or unresolved assembly checks. Proven numeric subchecks are reported within explanations, not promoted to whole-device `ok`.

## Official sources reviewed

- https://www.sparkfun.com/lithium-ion-battery-2200mah-7-4v.html — two cells, 7.4 V, 2200 mAh, special charger, no protection.
- https://www.pololu.com/product/3040/specs — voltage-specific motor performance and theoretical stall cautions.
- https://toshiba.semicon-storage.com/info/TB6612FNG_datasheet_en_20141001.pdf?did=10660&prodName=TB6612FNG — current ratings and pulse limitation.
- https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf — ESP32 electrical limits; not permission for direct 5 V signals.

## Checks and limits

Run `node pcb-studio/tests/hardware.mjs` (Node 26 native TypeScript). Regression assertions cover 1S rejection, 2S unresolved protection, charged motor voltage, missing driver/specs, invalid rail, peripheral warnings, substitution severity and cost changes. `git diff --check` passes.

No bench measurements, full app build (dependencies absent), discharge/thermal tests, protection sizing, connector ratings, mechanical fitting, or full netlist verification performed. The checker screens assigned device rails; it does not solve a power network or automatically propagate an arbitrary pack substitution into every device rail. No UI, rendering, routing or Lean changes.
