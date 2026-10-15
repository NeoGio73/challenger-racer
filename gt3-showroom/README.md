# 911 GT3 Showroom & Hochwald Ring

A three.js showroom for a satin Lizard Green Porsche 911 GT3 (992), with a sim-style
drive mode on the Hochwald Ring, a fictional 3.54 km mountain circuit.

Open `index.html` from a web server (GitHub Pages works; double-clicking the file does not,
because the page uses JavaScript modules).

## Showroom
- Turntable, front ¾, rear ¾, profile and driver's-seat views
- Six paint colours in satin, gloss or matte
- Arrow keys turn the front wheels and steering wheel

## Drive mode
- **↑ ↓ / W S**: throttle and brake (hold brake when stopped to reverse)
- **← → / A D**: steer
- **Q / E**: shift down / up (switches to manual), **M**: automatic
- **T / B**: traction control / ABS on or off
- **C**: camera (chase, cockpit, bumper, TV) · **R**: reset onto the track
- **Space**: handbrake · **V**: sound · **U**: mph / km/h · **H**: help · **Esc**: back to showroom
- Touch buttons appear on phones and tablets

## Files
- `index.html`: showroom page, HUD and styles
- `physics.js`: vehicle model (6-DOF chassis, raycast suspension, combined-slip tyres, RWD with LSD, 7-speed gearbox, aero)
- `trackdata.js`: circuit centreline, elevation and the ground-height function shared by physics and scenery
- `track.js`: scenery (terrain, road, kerbs, armco, forest, grandstand, pits, gantry, brake boards)
- `drive.js`: drive mode (input, cameras, lap timing, start lights, engine audio)
- `porsche_gt3_model.js`: the car model (Draco-compressed glTF, base64)
- `draco/`: Draco decoder from three.js

three.js 0.170.0 (MIT) loads from the jsDelivr CDN. The car model is a BlenderKit asset,
optimised for the web; its original licence terms still apply.
