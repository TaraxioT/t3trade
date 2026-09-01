/**
 * DOM HUD: sound toggle, reset view, loading state. Owner: UI worker.
 *
 * The HUD owns its pressed state for the sound toggle and reports every
 * change through onToggleSound(next); it does not touch the audio module
 * directly. Buttons keep a 34px visual box inside a 44x44 touch target.
 */
export interface Hud {
  setSoundEnabled(enabled: boolean): void;
  setLoading(visible: boolean): void;
  /** Remove the cluster from the DOM; safe to call twice. */
  destroy(): void;
}

export interface HudActions {
  onResetView: () => void;
  onToggleSound: (next: boolean) => void;
}

const STYLE_ID = "diorama-hud-style";

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
.diorama-hud-btn{
  position:relative;
  width:44px;
  height:44px;
  padding:0;
  border:none;
  background:transparent;
  cursor:pointer;
  pointer-events:auto;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  font-size:10px;
}
.diorama-hud-btn::before{
  content:"";
  position:absolute;
  inset:5px;
  border-radius:10px;
  background:rgba(10,24,40,.88);
  border:1px solid rgba(52,229,229,.25);
  transition:border-color .15s ease,background .15s ease;
}
.diorama-hud-btn svg{
  position:relative;
  z-index:1;
  color:#a8c0cf;
  transition:color .15s ease;
}
.diorama-hud-btn:hover svg{
  color:#f5fbff;
}
.diorama-hud-btn:hover::before{
  border-color:rgba(52,229,229,.55);
  background:rgba(16,38,60,.92);
}
.diorama-hud-btn:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:2px;
}
.diorama-hud-btn[aria-pressed="true"] svg{
  color:#34E5E5;
}
.diorama-hud-btn[aria-pressed="true"]::before{
  border-color:rgba(52,229,229,.55);
}
@media (prefers-reduced-motion: reduce){
  .diorama-hud-btn svg,
  .diorama-hud-btn::before{
    transition:none;
  }
}
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

export function createHud(root: HTMLElement, actions: HudActions): Hud {
  injectStyles();
  root.style.pointerEvents = "none";

  const cluster = document.createElement("div");
  cluster.className = "diorama-hud-cluster";

  // Sound toggle: starts muted; the HUD owns the pressed state.
  const soundBtn = document.createElement("button");
  soundBtn.type = "button";
  soundBtn.className = "diorama-hud-btn";
  soundBtn.setAttribute("aria-label", "Toggle sound");
  soundBtn.setAttribute("aria-pressed", "false");
  soundBtn.innerHTML = speakerIcon(true);

  // Reset view. The callback also clears any station selection.
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "diorama-hud-btn";
  resetBtn.setAttribute("aria-label", "Reset view");
  resetBtn.title = "Reset view";
  resetBtn.innerHTML = crosshairIcon();

  cluster.append(soundBtn, resetBtn);
  root.appendChild(cluster);

  let soundOn = false;

  const setSoundEnabled = (enabled: boolean): void => {
    soundOn = enabled;
    soundBtn.setAttribute("aria-pressed", String(enabled));
    soundBtn.innerHTML = speakerIcon(!enabled);
  };

  const onSoundClick = (): void => {
    const next = !soundOn;
    setSoundEnabled(next);
    actions.onToggleSound(next);
  };
  const onResetClick = (): void => actions.onResetView();
  soundBtn.addEventListener("click", onSoundClick);
  resetBtn.addEventListener("click", onResetClick);

  const host = root.closest<HTMLElement>("[data-diorama-host]") ?? root.parentElement ?? root;

  const setLoading = (visible: boolean): void => {
    const loading = host.querySelector<HTMLElement>("[data-diorama-loading]");
    if (loading) loading.hidden = !visible;
  };

  return {
    setSoundEnabled,
    setLoading,
    destroy(): void {
      soundBtn.removeEventListener("click", onSoundClick);
      resetBtn.removeEventListener("click", onResetClick);
      cluster.remove();
    },
  };
}
