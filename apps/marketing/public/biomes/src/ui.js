// DOM overlay: loading, island selector, info panel, hover tag, hints,
// and the WebGL failure state. The 3D scene stays the dominant interface;
// chrome is text-first, dark glass, mint accent, mono labels.

export function createUI() {
  const $ = (id) => document.getElementById(id);
  const hoverTag = $("hoverTag");
  const hint = $("hint");
  const panel = $("panel");
  const bar = $("loadBar");
  const loading = $("loading");
  let selectHandler = null;
  let hoverVisible = false;

  const SHORT = {
    forest: "Forest",
    farm: "Farm",
    desert: "Oasis",
    beach: "Shore",
    glacier: "Glacier",
    volcano: "Caldera",
    wetlands: "Wetlands",
  };

  //Build the island selector buttons
  const strip = $("strip");
  const buttons = new Map();
  const ORDER = ["forest", "farm", "desert", "beach", "glacier", "volcano", "wetlands"];
  const KEYS = {
    forest: "1",
    farm: "2",
    desert: "3",
    beach: "4",
    glacier: "5",
    volcano: "6",
    wetlands: "7",
  };
  ORDER.forEach((id, i) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.type = "button";
    btn.innerHTML = `<span class="k">${KEYS[id]}</span>${SHORT[id]}`;
    btn.setAttribute("aria-pressed", "false");
    btn.title = `Focus ${SHORT[id]} (key ${KEYS[id]})`;
    btn.addEventListener("click", () => selectHandler?.(id));
    strip.appendChild(btn);
    buttons.set(id, btn);
  });
  const overview = document.createElement("button");
  overview.className = "chip overview";
  overview.type = "button";
  overview.textContent = "Overview";
  overview.title = "Return to the full seven island view (Escape)";
  overview.addEventListener("click", () => selectHandler?.(null));
  strip.appendChild(overview);
  $("panelBack").addEventListener("click", () => selectHandler?.(null));

  const hintSeen = (() => {
    let seen = false;
    return () => {
      if (seen) return;
      seen = true;
      hint.classList.add("fade");
    };
  })();

  function setProgress(t) {
    bar.style.transform = `scaleX(${t})`;
  }

  function ready() {
    loading.classList.add("done");
    setTimeout(() => loading.remove(), 650);
  }

  function showPanel(def, index) {
    $("panelName").textContent = `${index + 1}. ${def.name}`;
    $("panelFamily").textContent = def.family;
    $("panelChannel").textContent = def.channel;
    $("panelChannel").dataset.channel = def.channel.toLowerCase();
    $("panelBlurb").textContent = def.blurb;
    $("panelDetails").textContent = def.details;
    panel.classList.add("open");
    hintSeen();
  }

  function hidePanel() {
    panel.classList.remove("open");
  }

  function setActiveButton(id) {
    buttons.forEach((btn, bid) => btn.setAttribute("aria-pressed", String(bid === id)));
  }

  function showHoverTag(x, y, name) {
    hoverTag.textContent = name;
    hoverVisible = true;
    hoverTag.classList.add("on");
    moveHoverTag(x, y);
  }
  function moveHoverTag(x, y) {
    if (!hoverVisible) return;
    hoverTag.style.transform = `translate(${x + 14}px, ${y - 10}px)`;
  }
  function hideHoverTag() {
    hoverVisible = false;
    hoverTag.classList.remove("on");
  }

  function webglFailed() {
    loading.remove();
    const fail = $("webglFail");
    fail.hidden = false;
  }

  hideHoverTag();

  return {
    onSelect(fn) {
      selectHandler = fn;
    },
    setProgress,
    ready,
    showPanel,
    hidePanel,
    setActiveButton,
    showHoverTag,
    moveHoverTag,
    hideHoverTag,
    hintSeen,
    webglFailed,
  };
}
