CHALLENGER / CITY SPRINT

Open index.html in a current browser to play. All game code and assets are local;
no package installation or asset downloads are needed. A static web host can serve
this folder as-is. Touch controls appear on touch-capable devices.

Drive: WASD or arrow keys. Space: drift. R: reset (+3 seconds). P or Escape: pause.
On mobile, hold GAS and a steering button together. BRAKE slows the car and then
reverses it. Pass every green checkpoint in order and complete three laps.

This version uses the user's low-poly Challenger, exported from Blender at
2,008 triangles. Color-based material consolidation reduces its 25 original
material draws to 11. The road and modular city are original procedural geometry;
the Kenney asset packs are not included because downloads were unavailable.
The vehicle model's original ownership and usage rights remain unchanged.

The game uses Three.js 0.180.0, MIT license, included in THREE-LICENSE.txt.
Engine and tire sounds are synthesized locally using Web Audio.

Files: index.html and style.css contain the interface; game.js contains
rendering and controls; race-core.js contains driving and checkpoint logic;
challenger.js contains the exported car geometry.

This is an arcade time trial, not a simulation or multiplayer game. No account,
analytics, remote data service, or external CDN is required by the game itself.
Hosting services may impose their own access requirements.


ALSO IN THIS REPO

gt3-showroom/ is a separate three.js project: a Porsche 911 GT3 showroom with a
sim-style drive mode on a fictional mountain circuit. See gt3-showroom/README.md.
