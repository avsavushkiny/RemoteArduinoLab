const path = require("path");
module.exports = {
  port: Number(process.env.PORT || 3000),
  cameraName: process.env.CAMERA_NAME || "A4TECH USB2.0 PC Camera",
  ffmpegPath: process.env.FFMPEG_PATH || "C:\\ffmpeg\\bin\\ffmpeg.exe",
  // Для Arduino Uno R3 с обычным загрузчиком Optiboot обычно используется 115200.
  // Для старого загрузчика может потребоваться 57600.
  arduino: {
    mcu: "atmega328p",
    programmer: "arduino",
    baudRate: Number(process.env.ARDUINO_BAUD || 115200),
    avrdudePath: process.env.AVRDUDE_PATH || "",
    avrdudeConfigPath: process.env.AVRDUDE_CONFIG || "",
    flashTimeoutMs: 60000
  },
  maxUploadBytes: 16 * 1024 * 1024,
  outputWidth: Number(process.env.CAMERA_WIDTH || 640),
  frameRate: Number(process.env.CAMERA_FPS || 15),
  jpegQuality: Number(process.env.CAMERA_QUALITY || 7),
  inputBuffer: process.env.CAMERA_BUFFER || "64M"
};
