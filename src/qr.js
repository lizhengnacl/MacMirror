import QRCode from "qrcode";

const ERROR_CORRECTION_LEVEL = "M";
const QUIET_ZONE_MODULES = 4;

export async function renderQrTerminal(text) {
  return QRCode.toString(text, {
    type: "terminal",
    small: true,
    margin: QUIET_ZONE_MODULES,
    errorCorrectionLevel: ERROR_CORRECTION_LEVEL
  });
}

export async function renderQrSvg(text, moduleSize = 8) {
  return QRCode.toString(text, {
    type: "svg",
    margin: QUIET_ZONE_MODULES,
    scale: moduleSize,
    errorCorrectionLevel: ERROR_CORRECTION_LEVEL
  });
}
