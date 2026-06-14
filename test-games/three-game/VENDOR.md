# three.module.js is vendored, not committed

Fetch the pinned Three.js build before packaging:

    curl -sL https://unpkg.com/three@0.160.0/build/three.module.js \
      -o test-games/three-game/three.module.js

Then package: `zip -X three-game.jsgame main.js three.module.js package.json`
