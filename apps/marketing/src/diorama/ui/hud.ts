/**
 * DOM HUD: mission strip (top-left), sound toggle + reset view (top-right),
 * loading state. Owner: UI worker.
 *
 * The mission strip (freeze cycle-4 §9) is bus-driven via setMission /
 * setBreadcrumb / setLastEvent; station text never feeds it. It collapses to
 * an "ETH · <status>" chip through an accessible toggle, defaults collapsed
 * below 640 px at creation, never auto-expands, persists nothing, and does
 * not animate under reduced motion. The strip container is pointer-events
 * none with pointer-events auto only on the toggle, so world gestures pass
 * through everywhere except the button itself.
 *
 * The HUD owns the pressed state for the sound toggle and reports every
 * change through onToggleSound(next); it does not touch the audio module
 * directly. Buttons keep a 34px visual box inside a 44x44 touch target.
 */
import { PALETTE, css } from "../config/palette.js";

export type MissionBreadcrumbStep = "Analyse" | "Wait" | "Execute" | "Position";

export interface Hud {
  setSoundEnabled(enabled: boolean): void;
  setLoading(visible: boolean): void;
  /** Exact mission status label; optional blocked reason is appended. */
  setMission(status: string, blockedReason?: string): void;
  /** Highlight the current product-flow step in the breadcrumb. */
  setBreadcrumb(step: MissionBreadcrumbStep): void;
  /** Latest event discriminator, e.g. "trading.execution-requested". */
  setLastEvent(name: string): void;
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
.diorama-mission{
  position:absolute;
  top:16px;
  left:16px;
  z-index:5;
  display:flex;
  flex-direction:column;
  align-items:flex-start;
  gap:6px;
  pointer-events:none;
  max-width:calc(100% - 76px);
}
.diorama-mission-toggle{
  display:inline-flex;
  align-items:center;
  gap:7px;
  max-width:100%;
  /* 44px minimum keeps the collapse chip a valid touch target. */
  min-height:44px;
  padding:7px 11px;
  border:none;
  border-radius:10px;
  background:rgba(10,24,40,.88);
  border:1px solid rgba(52,229,229,.25);
  cursor:pointer;
  pointer-events:auto;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  transition:border-color .15s ease,background .15s ease;
}
.diorama-mission-toggle:hover{
  border-color:rgba(52,229,229,.55);
  background:rgba(16,38,60,.92);
}
.diorama-mission-toggle:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:2px;
}
.diorama-mission-market{
  flex:none;
  font-size:10px;
  font-weight:500;
  letter-spacing:.1em;
  color:#07111f;
  background:#34E5E5;
  border-radius:5px;
  padding:2px 6px;
}
.diorama-mission-status{
  font-size:10px;
  letter-spacing:.08em;
  text-transform:uppercase;
  color:#f5fbff;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.diorama-mission-chev{
  flex:none;
  color:#a8c0cf;
  transition:transform .15s ease;
}
.diorama-mission-toggle[aria-expanded="true"] .diorama-mission-chev{
  transform:rotate(180deg);
}
.diorama-mission-panel{
  padding:9px 12px;
  border-radius:10px;
  background:rgba(10,24,40,.88);
  border:1px solid rgba(52,229,229,.25);
  pointer-events:none;
  max-width:100%;
}
.diorama-mission-breadcrumb{
  display:flex;
  align-items:center;
  gap:5px;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px;
  letter-spacing:.06em;
  white-space:nowrap;
}
.diorama-mission-step{
  color:#5a7180;
  padding:1px 2px;
}
.diorama-mission-step-current{
  color:#34E5E5;
  border-bottom:1px solid rgba(52,229,229,.6);
}
.diorama-mission-sep{
  color:#3a5568;
}
.diorama-mission-event{
  margin-top:6px;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9px;
  letter-spacing:.04em;
  color:#a8c0cf;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
@media (prefers-reduced-motion: reduce){
  .diorama-hud-btn svg,
  .diorama-hud-btn::before,
  .diorama-mission-toggle,
  .diorama-mission-chev{
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

function chevronIcon(): string {
  return `<svg class="diorama-mission-chev" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

const BREADCRUMB_STEPS: MissionBreadcrumbStep[] = ["Analyse", "Wait", "Execute", "Position"];

/** Market chip label: the exhibit follows one simulated ETH mission. */
const MARKET_LABEL = "ETH";

/** Semantic status color, mirroring the info-card heuristic wording rules. */
function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (/(blocked|refus|revoked|fail)/.test(s)) return css(PALETTE.blocked);
  if (/(paus|degrad|warn|loss)/.test(s)) return css(PALETTE.warning);
  if (/(position open|completed|filled|executing)/.test(s)) return css(PALETTE.healthy);
  return css(PALETTE.waiting);
}

export function createHud(root: HTMLElement, actions: HudActions): Hud {
  injectStyles();
  root.style.pointerEvents = "none";

  // ----- Mission strip (top-left). -----
  const mission = document.createElement("div");
  mission.className = "diorama-mission";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "diorama-mission-toggle";
  toggle.setAttribute("aria-expanded", "false");
  const marketChip = document.createElement("span");
  marketChip.className = "diorama-mission-market";
  marketChip.textContent = MARKET_LABEL;
  const statusSpan = document.createElement("span");
  statusSpan.className = "diorama-mission-status";
  statusSpan.setAttribute("aria-live", "polite");
  statusSpan.textContent = "Standby";
  toggle.append(marketChip, statusSpan);
  toggle.insertAdjacentHTML("beforeend", chevronIcon());

  const panel = document.createElement("div");
  panel.className = "diorama-mission-panel";
  const panelId = "diorama-mission-panel";
  panel.id = panelId;
  toggle.setAttribute("aria-controls", panelId);

  const breadcrumb = document.createElement("div");
  breadcrumb.className = "diorama-mission-breadcrumb";
  const stepEls = new Map<MissionBreadcrumbStep, HTMLSpanElement>();
  BREADCRUMB_STEPS.forEach((step, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "diorama-mission-sep";
      sep.textContent = "›";
      breadcrumb.appendChild(sep);
    }
    const el = document.createElement("span");
    el.className = "diorama-mission-step";
    el.textContent = step;
    breadcrumb.appendChild(el);
    stepEls.set(step, el);
  });

  const eventLine = document.createElement("div");
  eventLine.className = "diorama-mission-event";
  eventLine.textContent = "—";

  panel.append(breadcrumb, eventLine);
  mission.append(toggle, panel);
  root.appendChild(mission);

  // Default collapsed below 640 px at creation only; never persisted and
  // never auto-expanded by later calls.
  let expanded = !window.matchMedia("(max-width: 640px)").matches;
  const applyExpanded = (): void => {
    panel.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
  };
  applyExpanded();

  const onToggleClick = (): void => {
    expanded = !expanded;
    applyExpanded();
  };
  toggle.addEventListener("click", onToggleClick);

  const setMission = (status: string, blockedReason?: string): void => {
    // The blocked reason is part of the honest status line, not a separate
    // error surface: "Blocked · cumulative_loss_limit".
    statusSpan.textContent = blockedReason ? `${status} · ${blockedReason}` : status;
    statusSpan.style.color = statusColor(blockedReason ? `${status} ${blockedReason}` : status);
  };

  const setBreadcrumb = (step: MissionBreadcrumbStep): void => {
    for (const [name, el] of stepEls) {
      el.classList.toggle("diorama-mission-step-current", name === step);
    }
  };

  const setLastEvent = (name: string): void => {
    eventLine.textContent = name;
  };

  // ----- Sound + reset cluster (top-right). -----
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
    setMission,
    setBreadcrumb,
    setLastEvent,
    destroy(): void {
      toggle.removeEventListener("click", onToggleClick);
      soundBtn.removeEventListener("click", onSoundClick);
      resetBtn.removeEventListener("click", onResetClick);
      mission.remove();
      cluster.remove();
    },
  };
}
