const CHANNEL = "module.pum-companion-bridge";
const SAMPLE_COUNT = 8;

let mapping = null;

/** The text of the first element a mapping names, taken out of the card. */
function takeText(card, selector) {
  if (!selector) return null;
  try {
    const node = card.querySelector(selector);
    const text = node?.textContent.replace(/\s+/g, " ").trim() || null;
    node?.remove();
    return text;
  } catch {
    return null;
  }
}

/** The card written out by the first of the player's formats that fits it. */
function fillTemplate(card) {
  for (const format of mapping?.cards ?? []) {
    try {
      if (format.when && !card.matches(format.when) && !card.querySelector(format.when)) continue;
      const values = {};
      for (const [name, selector] of Object.entries(format.fields ?? {})) {
        const parts = Array.from(card.querySelectorAll(selector), node => node.textContent.replace(/\s+/g, " ").trim());
        values[name] = parts.filter(Boolean).join(" · ");
      }
      const lines = format.template.split("\n").filter(line => {
        const names = Array.from(line.matchAll(/\{(\w+)\}/g), match => match[1]);
        return !names.length || names.some(name => values[name]);
      });
      return lines.map(line => line.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "")).join("\n").trim() || null;
    } catch { /* a player's selector can be wrong */ }
  }
  return null;
}

/** Reads a rendered card as the browser displays it. Pictures with a name become that name. */
function readCard(root) {
  // On the untouched card: results can sit inside what the cleanup below removes.
  const markdown = fillTemplate(root);
  const card = root.cloneNode(true);
  card.querySelectorAll(".message-sender, .message-metadata, .dice-formula, .dice-tooltip, button")
    .forEach(node => node.remove());
  card.querySelectorAll(".message-header img").forEach(node => node.remove());
  for (const selector of mapping?.hide ?? []) {
    try {
      card.querySelectorAll(selector).forEach(node => node.remove());
    } catch { /* a player's selector can be wrong */ }
  }
  const title = takeText(card, mapping?.title);
  const result = takeText(card, mapping?.result) ?? takeText(card, ".dice-total");
  const images = Array.from(card.querySelectorAll("img"), image => image.getAttribute("src"));
  card.querySelectorAll("img[alt]").forEach(image => image.replaceWith(image.getAttribute("alt")));

  const stage = document.createElement("ol");
  stage.className = "chat-log";
  stage.style.cssText = "position:absolute;left:-10000px;top:0;width:300px;list-style:none";
  stage.append(card);
  document.body.append(stage);
  const text = stage.innerText.replace(/\n{3,}/g, "\n\n").trim();
  stage.remove();
  return { text, images, result, title, markdown };
}

/** Sends one rendered chat card. Only the author's client sends, so each card goes out once. */
async function forward(message, event) {
  if (!message.isAuthor) return;
  if (message.whisper.length || message.blind) return;
  const html = await message.renderHTML();
  const root = html instanceof Element ? html : html[0];
  if (!root) return;
  game.socket.emit(CHANNEL, {
    version: 1,
    event,
    id: message.id,
    timestamp: message.timestamp,
    speaker: {
      alias: message.alias,
      actorId: message.speaker.actor,
      tokenId: message.speaker.token,
      sceneId: message.speaker.scene,
      image: message.speakerActor?.img ?? null
    },
    author: { id: message.author?.id ?? null, name: message.author?.name ?? null },
    ...readCard(root),
    html: root.outerHTML
  });
}

let capture = null;
let picturesWanted = false;

/** Loads the capture library once, when the first picture is needed. */
function loadCapture() {
  capture ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "modules/pum-companion-bridge/vendor/html-to-image.js";
    script.onload = () => resolve(window.htmlToImage);
    script.onerror = reject;
    document.head.append(script);
  });
  return capture;
}

/** A copy of the card someone can see: the chat log's, or the floating one. */
async function findDrawnCard(id) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const copies = Array.from(document.querySelectorAll(`[data-message-id="${id}"]`));
    const card = copies.find(copy => copy.checkVisibility?.() && copy.offsetHeight > 20);
    if (card) {
      // Let its entrance animation settle before the picture.
      await new Promise(resolve => setTimeout(resolve, 400));
      return card;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

const fontFiles = new Map();
const fontSets = new Map();

/** Font families a card draws with, its icons included. */
function familiesIn(card) {
  const families = new Set();
  for (const node of [card, ...card.querySelectorAll("*")]) {
    for (const part of [null, "::before", "::after"]) {
      for (const family of getComputedStyle(node, part).fontFamily.split(",")) {
        families.add(family.trim().replace(/^["']|["']$/g, "").toLowerCase());
      }
    }
  }
  return families;
}

/** Every @font-face on the page with the address it resolves against, inside layers and imports too. */
function fontFaces() {
  const faces = [];
  const rulesOf = sheet => {
    try {
      return sheet.cssRules;
    } catch {
      return [];
    }
  };
  const walk = (rules, base) => {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) faces.push({ rule, base });
      else if (rule instanceof CSSImportRule && rule.styleSheet) walk(rulesOf(rule.styleSheet), rule.styleSheet.href ?? base);
      else if (rule.cssRules) walk(rule.cssRules, base);
    }
  };
  for (const sheet of document.styleSheets) walk(rulesOf(sheet), sheet.href ?? location.href);
  return faces;
}

async function asDataUrl(url) {
  if (!fontFiles.has(url)) {
    fontFiles.set(url, fetch(url).then(response => response.blob()).then(blob => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    })).catch(() => null));
  }
  return fontFiles.get(url);
}

/** The card's fonts, embedded: a picture can't reach the page's fonts on its own. */
async function fontCss(card) {
  const families = familiesIn(card);
  const key = [...families].sort().join("|");
  if (fontSets.has(key)) return fontSets.get(key);
  const css = [];
  for (const { rule, base } of fontFaces()) {
    const family = rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (!families.has(family)) continue;
    let text = rule.cssText;
    for (const [whole, address] of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (address.startsWith("data:")) continue;
      const data = await asDataUrl(new URL(address, base).href);
      if (data) text = text.replace(whole, `url("${data}")`);
    }
    css.push(text);
  }
  const result = css.join("\n");
  fontSets.set(key, result);
  return result;
}

/** Pictures the card where it is, without what the entry already shows or can't use. */
async function pictureOf(card) {
  const { toCanvas } = await loadCapture();
  const canvas = await toCanvas(card, {
    pixelRatio: 2,
    fontEmbedCSS: await fontCss(card),
    filter: node => !node.matches?.(".message-metadata, .message-sender, button"),
    style: { height: "auto", margin: "0" }
  });
  // WebP keeps the rounded corners, far smaller than a PNG. Below this, small text blurs.
  return canvas.toDataURL("image/webp", 0.9);
}

/** Sends a picture of the card as drawn: the only generic way to keep its look. */
async function sendPicture(message) {
  if (!picturesWanted || !message.isAuthor || message.whisper.length || message.blind) return;
  try {
    const card = await findDrawnCard(message.id);
    if (!card) return;
    const picture = await pictureOf(card);
    game.socket.emit(CHANNEL, { version: 1, event: "picture", id: message.id, picture });
  } catch (error) {
    console.warn("PUM Companion Bridge | card picture failed", error);
  }
}

/** The latest public cards in Foundry's chat, for AI to learn this system's format. */
async function sendSamples() {
  const messages = game.messages.contents.filter(message => !message.whisper.length && !message.blind);
  const samples = [];
  for (const message of messages.slice(-SAMPLE_COUNT)) {
    const html = await message.renderHTML();
    const root = html instanceof Element ? html : html[0];
    if (root) samples.push({ html: root.outerHTML, data: { flags: message.toObject().flags } });
  }
  game.socket.emit(CHANNEL, { version: 1, event: "samples", samples });
}

Hooks.once("ready", () => {
  game.socket.on(CHANNEL, data => {
    if (data?.event === "pictures") picturesWanted = data.on === true;
    if (data?.event === "mapping") mapping = data.mapping ?? null;
    if (data?.event === "samples-request" && game.user.isGM) sendSamples();
  });
  game.socket.emit(CHANNEL, { version: 1, event: "hello" });
});

Hooks.on("createChatMessage", message => {
  forward(message, "create");
  sendPicture(message);
});
Hooks.on("updateChatMessage", message => {
  forward(message, "update");
  sendPicture(message);
});
