import sharp from 'sharp';
await sharp('assets/icon.svg').png().toFile('assets/icon.png');
const tray = '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><path fill="#26222d" d="M22 2C16 10 8 18 8 26a14 14 0 0028 0C36 18 28 10 22 2zm-2 30-6-6 3-3 3 3 8-8 3 3z"/></svg>';
await sharp(Buffer.from(tray)).png().toFile('assets/tray.png');
