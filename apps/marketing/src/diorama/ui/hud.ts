/**
 * DOM HUD: sound toggle, reset view, usage hint, loading state.
 * Owner: UI worker.
 *
 * main.ts wires onToggleSound to audio.setEnabled(true) only, so real muting
 * goes through the audio module's setDioramaAudioEnabled exported toggle; the
 * onToggleSound action is still invoked for future plumbing.
 */
import { setDioramaAudioEnabled } from "../audio.js";

export interface Hud {
  setSoundEnabled(enabled: boolean): void;
  setLoading(visible: boolean): void;
}

const STYLE_ID = "diorama-hud-style";

const GLASS = `
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:34px;
  height:34px;
  border-radius:10px;
  background:rgba(10,24,40,.88);
  border:1px solid rgba(52,229,229,.25);
  color:#a8c0cf;
  cursor:pointer;
  padding:0;
  transition:color .15s ease,border-color .15s ease,background .15s ease;
`;

const CSS = `
.diorama-hud-cluster{
  position:absolute;
  top:16px;
  right:16px;
  display:flex;
  flex-direction:column;
  align-items:flex-end;
  gap:8px;
  pointer-events:none;
}
.diorama-hud-cluster:hover{pointer-events:none}
.diorama-hud-btn{
  ${GLASS}
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9px;
  letter-spacing:.06em;
  pointer-events:auto;
}
.diorama-hud-btn:hover{
  color:#f5fbff;
  border-color:rgba(52,229,229,.55);
  background:rgba(16,38,60,.92);
}
.diorama-hud-btn:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:2px;
}
.diorama-hud-btn[aria-pressed="true"]{
  color:#34E5E5;
  border-color:rgba(52,229,229,.55);
}
.diorama-hud-hint{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px;
  letter-spacing:.05em;
  color:#a8c0cf;
  background:rgba(10,24,40,.75);
  border:1px solid rgba(52,229,229,.18);
  border-radius:8px;
  padding:5px 9px;
  max-width:230px;
  text-align:right;
  opacity:1;
  transition:opacity .6s ease;
  pointer-events:none;
}
.diorama-hud-hint-hidden{opacity:0}
@media (max-width:640px){.diorama-hud-hint{display:none}}
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const SPEAKER_ON = "M 3 9 v 6 h 4 l 5 4 V 5 L 7 9 Z";
const SPEAKER_WAVES = "M 15.5 8.5 a 5 5 0 0 1 0 7 M 18 6 a 8.5 8.5 0 0 1 0 12";
const SPEAKER_OFF_X = "M 16 9 l 6 6 M 22 9 l -6 6";

function speakerIcon(muted: boolean): string {
  const stroke = muted ? SPEAKER_OFF_X : SPEAKER_WAVES;
  return `<svg width="18" height="18" viewBox="0 0 26 24" fill="none" aria-hidden="true">
    <path d="${SPEAKER_ON}" fill="currentColor"/>
    <path d="${stroke}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function crosshairIcon(): string {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.6"/>
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="1.4" fill="currentColor"/>
  </svg>`;
}

export function createHud(root: HTMLElement, actions: { onResetView(): void; onToggleSound(): void }): Hud {
  injectStyles();
  root.style.pointerEvents = "none";

  const cluster = document.createElement("div");
  cluster.className = "diorama-hud-cluster";

  // Sound toggle: starts muted.
  const soundBtn = document.createElement("button");
  soundBtn.type = "button";
  soundBtn.className = "diorama-hud-btn";
  soundBtn.setAttribute("aria-label", "Toggle sound");
  soundBtn.setAttribute("aria-pressed", "false");
  soundBtn.innerHTML = speakerIcon(true);

  // Reset view.
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "diorama-hud-btn";
  resetBtn.setAttribute("aria-label", "Reset view");
  resetBtn.title = "Reset view";
  resetBtn.innerHTML = crosshairIcon();

  // Interaction hint: fades after 8 s or the first pointer interaction.
  const hint = document.createElement("p");
  hint.className = "diorama-hud-hint";
  hint.textContent = "Drag to pan · Scroll to zoom · Click a station";

  cluster.append(soundBtn, resetBtn, hint);
  root.appendChild(cluster);

  let soundOn = false;

  const setSoundEnabled = (enabled: boolean): void => {
    soundOn = enabled;
    soundBtn.setAttribute("aria-pressed", String(enabled));
    soundBtn.innerHTML = speakerIcon(!enabled);
  };

  soundBtn.addEventListener("click", () => {
    const next = !soundOn;
    // main.ts forwards setEnabled(true) only, so drive the real state here.
    setDioramaAudioEnabled(next);
    setSoundEnabled(next);
    actions.onToggleSound();
  });
  resetBtn.addEventListener("click", () => actions.onResetView());

  const dismissHint = (): void => {
    hint.classList.add("diorama-hud-hint-hidden");
    host.removeEventListener("pointerdown", dismissHint);
    host.removeEventListener("wheel", dismissHint);
  };
  const host = root.closest<HTMLElement>("[data-diorama-host]") ?? root.parentElement ?? root;
  const hintTimer = window.setTimeout(dismissHint, 8000);
  host.addEventListener("pointerdown", dismissHint);
  host.addEventListener("wheel", dismissHint, { passive: true });

  const setLoading = (visible: boolean): void => {
    const loading = host.querySelector<HTMLElement>("[data-diorama-loading]");
    if (loading) loading.hidden = !visible;
  };

  void hintTimer;
  return { setSoundEnabled, setLoading };
}
