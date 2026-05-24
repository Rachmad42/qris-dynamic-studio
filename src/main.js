import QRCode from "qrcode";
import jsQR from "jsqr";
import qrisTemplateUrl from "./QRIS_Preview.png";
import "./styles.css";

const state = {
  sourceQris: "",
  dynamicQris: "",
  merchantName: "",
  originalMerchantName: "",
  nmid: "",
  storeLabel: "A01",
  amount: "15000",
  inputMode: "photo",
  lastRequestId: 0,
};

const API_BASE_URL = window.QRIS_API_BASE_URL || "https://qris-static-to-dynamic-api.netid-id01.workers.dev";
const STORAGE_KEY = "qris-dynamic-studio:last-data";
const THEME_STORAGE_KEY = "qris-dynamic-studio:theme";
const THEME_OPTIONS = ["system", "light", "dark"];
const THEME_CLOSE_DELAY = 320;
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let themeCloseTimeoutId;

const els = {
  amount: document.querySelector("#amount"),
  amountBadge: document.querySelector("#amountBadge"),
  canvas: document.querySelector("#posterCanvas"),
  downloadButton: document.querySelector("#downloadButton"),
  dropZone: document.querySelector("#dropZone"),
  merchantName: document.querySelector("#merchantName"),
  merchantWarning: document.querySelector("#merchantWarning"),
  nmid: document.querySelector("#nmid"),
  photoMode: document.querySelector("#photoMode"),
  photoTab: document.querySelector("#photoTab"),
  qrisImage: document.querySelector("#qrisImage"),
  qrisText: document.querySelector("#qrisText"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  textMode: document.querySelector("#textMode"),
  textTab: document.querySelector("#textTab"),
  themeMenu: document.querySelector("#themeMenu"),
  themeOptions: document.querySelectorAll("[data-theme-option]"),
  themeSwitcher: document.querySelector("#themeSwitcher"),
  themeToggle: document.querySelector("#themeToggle"),
  themeToggleIcon: document.querySelector("#themeToggleIcon"),
};

const ctx = els.canvas.getContext("2d");
const POSTER_WIDTH = 1055;
const POSTER_HEIGHT = 1491;
const QR_BOX = {
  x: 258,
  y: 455,
  size: 540,
};
const templateImagePromise = loadImage(qrisTemplateUrl);

function getSavedTheme() {
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_OPTIONS.includes(savedTheme) ? savedTheme : "system";
  } catch {
    return "system";
  }
}

function getResolvedTheme(themeChoice) {
  if (themeChoice === "system") {
    return systemThemeQuery.matches ? "dark" : "light";
  }

  return themeChoice;
}

function getThemeIcon(themeChoice) {
  if (themeChoice === "light") {
    return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }

  if (themeChoice === "dark") {
    return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
      <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
    </svg>`;
  }

  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
    <path d="M4 5h16v10H4V5Z" stroke="currentColor" stroke-width="2" />
    <path d="M9 19h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    <path d="M12 15v4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>`;
}

function applyTheme(themeChoice) {
  const normalizedTheme = THEME_OPTIONS.includes(themeChoice) ? themeChoice : "system";
  const resolvedTheme = getResolvedTheme(normalizedTheme);

  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeChoice = normalizedTheme;
  els.themeToggleIcon.innerHTML = getThemeIcon(normalizedTheme);
  els.themeOptions.forEach((button) => {
    const isSelected = button.dataset.themeOption === normalizedTheme;
    button.setAttribute("aria-checked", String(isSelected));
  });
}

function setTheme(themeChoice) {
  applyTheme(themeChoice);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeChoice);
  } catch {
    // Some browser privacy modes can disable localStorage.
  }
}

function setThemeMenuOpen(isOpen) {
  window.clearTimeout(themeCloseTimeoutId);
  els.themeSwitcher.dataset.open = String(isOpen);
  els.themeToggle.setAttribute("aria-expanded", String(isOpen));
}

function scheduleThemeMenuClose() {
  window.clearTimeout(themeCloseTimeoutId);
  themeCloseTimeoutId = window.setTimeout(() => {
    setThemeMenuOpen(false);
  }, THEME_CLOSE_DELAY);
}

function setStatus(message, tone = "idle") {
  els.statusText.textContent = message;
  els.statusDot.dataset.tone = tone;
}

function normalizeApiBaseUrl() {
  return API_BASE_URL.trim().replace(/\/+$/, "");
}

function formatCurrency(value) {
  const amount = Number(value || 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    return "Rp 0";
  }

  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function parseTlv(payload) {
  const fields = [];
  let index = 0;

  while (index + 4 <= payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    const valueStart = index + 4;
    const valueEnd = valueStart + length;

    if (!/^\d{2}$/.test(id) || !Number.isInteger(length) || valueEnd > payload.length) {
      break;
    }

    fields.push({ id, value: payload.slice(valueStart, valueEnd) });
    index = valueEnd;
  }

  return fields;
}

function isQrisPayloadValid(payload) {
  const qris = payload.trim();
  const fields = parseTlv(qris);
  const parsedLength = fields.reduce((total, field) => total + 4 + field.value.length, 0);
  const crcField = fields.at(-1);

  if (!qris || parsedLength !== qris.length || getField(fields, "00") !== "01") {
    return false;
  }

  if (crcField?.id !== "63" || crcField.value.length !== 4) {
    return false;
  }

  const crcPayload = qris.slice(0, -4);
  return crc16CcittFalse(crcPayload) === crcField.value.toUpperCase();
}

function crc16CcittFalse(input) {
  let crc = 0xffff;

  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index) << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function getField(fields, id) {
  return fields.find((field) => field.id === id)?.value || "";
}

function applyMetadataFromQris(qris) {
  const fields = parseTlv(qris);
  const merchantName = getField(fields, "59");
  const merchantInfo = parseTlv(getField(fields, "51"));
  const additionalData = parseTlv(getField(fields, "62"));
  const nmid = getField(merchantInfo, "02");
  const storeLabel = getField(additionalData, "07");

  if (merchantName) {
    els.merchantName.value = merchantName;
    state.merchantName = merchantName;
    state.originalMerchantName = merchantName;
  }

  if (nmid) {
    els.nmid.value = nmid;
    state.nmid = nmid;
  }

  if (storeLabel) {
    state.storeLabel = storeLabel;
  }
}

function updateMerchantWarning() {
  const currentMerchantName = els.merchantName.value.trim();
  const originalMerchantName = state.originalMerchantName.trim();

  els.merchantWarning.hidden =
    !originalMerchantName || currentMerchantName === originalMerchantName;
}

function saveLastData() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        amount: els.amount.value,
        merchantName: els.merchantName.value,
        nmid: els.nmid.value,
        qrisText: els.qrisText.value,
        storeLabel: state.storeLabel,
        inputMode: state.inputMode,
        originalMerchantName: state.originalMerchantName,
      })
    );
  } catch {
    // Some browser privacy modes can disable localStorage.
  }
}

function restoreLastData() {
  try {
    const savedData = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");

    if (!savedData) {
      return;
    }

    state.sourceQris = savedData.qrisText || "";
    applyMetadataFromQris(state.sourceQris);

    els.amount.value = savedData.amount || state.amount;
    els.merchantName.value = savedData.merchantName || "";
    els.nmid.value = savedData.nmid || "";
    els.qrisText.value = state.sourceQris;
    state.storeLabel = savedData.storeLabel || state.storeLabel;
    state.originalMerchantName = savedData.originalMerchantName || state.originalMerchantName;
    setInputMode(savedData.inputMode === "text" ? "text" : "photo");
    updateMerchantWarning();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function apiPost(path, body) {
  const response = await fetch(`${normalizeApiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload.data;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Unable to read image file.")));
    reader.readAsDataURL(file);
  });
}

async function decodeQrFromImageFile(file) {
  const imageDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(imageDataUrl);
  const canvas = document.createElement("canvas");
  const scanContext = canvas.getContext("2d", { willReadFrequently: true });

  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  scanContext.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = scanContext.getImageData(0, 0, canvas.width, canvas.height);
  const qrCode = jsQR(imageData.data, imageData.width, imageData.height);

  if (!qrCode?.data) {
    throw new Error("No QR code was detected in the image.");
  }

  return qrCode.data;
}

async function detectImage(file) {
  setStatus("Detecting QR code from image...", "busy");
  const qrisText = await decodeQrFromImageFile(file);

  state.sourceQris = qrisText;
  els.qrisText.value = qrisText;
  applyMetadataFromQris(qrisText);
  saveLastData();
  setStatus("QRIS photo detected", "ok");
  await updateDynamicQris();
}

const scheduleDynamicUpdate = debounce(() => {
  updateDynamicQris();
}, 300);

async function updateDynamicQris() {
  state.amount = els.amount.value;
  state.merchantName = els.merchantName.value.trim() || "MERCHANT NAME";
  state.nmid = els.nmid.value.trim();
  els.amountBadge.textContent = formatCurrency(state.amount);
  updateMerchantWarning();
  const hasValidQris = isQrisPayloadValid(state.sourceQris);
  saveLastData();

  if (!state.sourceQris.trim()) {
    state.dynamicQris = "";
    setStatus("Waiting for QRIS input", "idle");
    await renderPoster();
    return;
  }

  if (!hasValidQris) {
    state.dynamicQris = "";
    setStatus("Text QRIS tidak valid atau CRC tidak cocok", "error");
    await renderPoster();
    return;
  }

  const requestId = (state.lastRequestId += 1);

  try {
    setStatus("Generating dynamic QRIS...", "busy");
    const data = await apiPost("/qris/dynamic", {
      qris: state.sourceQris,
      amount: state.amount,
    });

    if (requestId !== state.lastRequestId) {
      return;
    }

    state.dynamicQris = data.qris;
    setStatus("Dynamic QRIS ready", "ok");
  } catch (error) {
    if (requestId !== state.lastRequestId) {
      return;
    }

    state.dynamicQris = "";
    setStatus(error.message, "error");
  }

  await renderPoster();
}

async function renderPoster() {
  const width = els.canvas.width;
  const height = els.canvas.height;
  const qrDataUrl = state.dynamicQris
    ? await QRCode.toDataURL(state.dynamicQris, {
        margin: 1,
        width: QR_BOX.size,
        color: {
          dark: "#050505",
          light: "#ffffff",
        },
      })
    : "";

  ctx.clearRect(0, 0, width, height);
  await drawTemplate();
  drawMerchantInfo();

  if (qrDataUrl) {
    await drawImage(qrDataUrl, QR_BOX.x, QR_BOX.y, QR_BOX.size, QR_BOX.size);
  } else {
    drawQrPlaceholder();
  }

  drawAmount();
}

async function drawTemplate() {
  const templateImage = await templateImagePromise;

  ctx.drawImage(templateImage, 0, 0, POSTER_WIDTH, POSTER_HEIGHT);
}

function drawMerchantInfo() {
  drawFittedCenteredText(
    state.merchantName || "MERCHANT NAME",
    283,
    760,
    "Arial",
    50,
    34,
    500,
    "#080808"
  );

  if (state.nmid) {
    drawFittedCenteredText(
      `NMID : ${state.nmid}`,
      356,
      760,
      "Arial",
      33,
      26,
      400,
      "#3d3d3d"
    );
  }

  drawFittedCenteredText(
    state.storeLabel || "A01",
    425,
    420,
    "Arial",
    33,
    26,
    400,
    "#3d3d3d"
  );
}

function drawQrPlaceholder() {
  ctx.save();
  ctx.fillStyle = "#f5f7f9";
  ctx.fillRect(QR_BOX.x, QR_BOX.y, QR_BOX.size, QR_BOX.size);
  ctx.strokeStyle = "#d7dde3";
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(QR_BOX.x, QR_BOX.y, QR_BOX.size, QR_BOX.size);
  drawCenteredText("QRIS preview", 735, "600 42px Arial", "#8b96a3");
  ctx.restore();
}

function drawAmount() {
  drawFittedCenteredText(
    formatCurrency(state.amount),
    1055,
    720,
    "Arial",
    58,
    38,
    700,
    "#0b0f19"
  );
  drawCenteredText("SATU QRIS UNTUK SEMUA", 1120, "400 39px Arial", "#3a3a3a");
  drawCenteredText("Cek aplikasi penyelenggara di:", 1185, "400 30px Arial", "#3a3a3a");
  drawCenteredText("www.aspi-qris.id", 1227, "400 33px Arial", "#3a3a3a");

  ctx.fillStyle = "#050505";
  ctx.font = "400 24px Arial";
  ctx.textAlign = "left";
  ctx.fillText("Dicetak oleh: QRIS Dynamic Studio", 40, 1400);
  ctx.fillText("Versi cetak: 1.0.0", 40, 1432);
}

function drawCenteredText(text, y, font, color) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(text, els.canvas.width / 2, y);
  ctx.restore();
}

function drawFittedCenteredText(
  text,
  y,
  maxWidth,
  family,
  maxSize,
  minSize,
  weight,
  color
) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = color;

  let size = maxSize;

  do {
    ctx.font = `${weight} ${size}px ${family}`;
    size -= 1;
  } while (ctx.measureText(text).width > maxWidth && size >= minSize);

  ctx.fillText(text, els.canvas.width / 2, y);
  ctx.restore();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.addEventListener("load", () => {
      resolve(image);
    });
    image.addEventListener("error", () => reject(new Error("Unable to load image asset.")));
    image.src = src;
  });
}

async function drawImage(src, x, y, width, height) {
  const image = await loadImage(src);

  ctx.drawImage(image, x, y, width, height);
}

function debounce(callback, delay) {
  let timeoutId;

  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delay);
  };
}

function setInputMode(mode) {
  const isPhoto = mode === "photo";

  state.inputMode = isPhoto ? "photo" : "text";
  els.photoTab.classList.toggle("active", isPhoto);
  els.textTab.classList.toggle("active", !isPhoto);
  els.photoMode.classList.toggle("active", isPhoto);
  els.textMode.classList.toggle("active", !isPhoto);
  saveLastData();
}

els.photoTab.addEventListener("click", () => setInputMode("photo"));
els.textTab.addEventListener("click", () => setInputMode("text"));

els.themeToggle.addEventListener("click", () => {
  setThemeMenuOpen(els.themeSwitcher.dataset.open !== "true");
});

els.themeSwitcher.addEventListener("mouseenter", () => {
  setThemeMenuOpen(true);
});

els.themeSwitcher.addEventListener("mouseleave", scheduleThemeMenuClose);

els.themeSwitcher.addEventListener("focusin", () => {
  setThemeMenuOpen(true);
});

els.themeSwitcher.addEventListener("focusout", () => {
  scheduleThemeMenuClose();
});

els.themeOptions.forEach((button) => {
  button.addEventListener("click", () => {
    setTheme(button.dataset.themeOption);
    setThemeMenuOpen(false);
    els.themeToggle.focus();
  });
});

document.addEventListener("click", (event) => {
  if (!els.themeSwitcher.contains(event.target)) {
    scheduleThemeMenuClose();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    scheduleThemeMenuClose();
    els.themeToggle.focus();
  }
});

systemThemeQuery.addEventListener("change", () => {
  if (getSavedTheme() === "system") {
    applyTheme("system");
  }
});

els.qrisImage.addEventListener("change", async () => {
  const [file] = els.qrisImage.files;

  if (!file) {
    return;
  }

  try {
    await detectImage(file);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("drag-over");
  });
});

els.dropZone.addEventListener("drop", async (event) => {
  const [file] = [...event.dataTransfer.files].filter((item) =>
    item.type.startsWith("image/")
  );

  if (!file) {
    setStatus("File yang dijatuhkan bukan gambar.", "error");
    return;
  }

  try {
    await detectImage(file);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

els.qrisText.addEventListener("input", () => {
  state.sourceQris = els.qrisText.value.trim();
  applyMetadataFromQris(state.sourceQris);
  saveLastData();
  scheduleDynamicUpdate();
});

[els.amount, els.merchantName, els.nmid].forEach((input) => {
  input.addEventListener("input", scheduleDynamicUpdate);
});

els.merchantName.addEventListener("input", updateMerchantWarning);

els.downloadButton.addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `qris-${Date.now()}.png`;
  link.href = els.canvas.toDataURL("image/png");
  link.click();
});

applyTheme(getSavedTheme());
restoreLastData();
updateDynamicQris();
