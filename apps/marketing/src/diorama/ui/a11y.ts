/**
 * Accessibility: textual station directory outside the canvas plus keyboard
 * exploration support. Owner: UI worker.
 *
 * A <details> with one button per station; focus routes through the shared
 * module-level focus helper in ui/interaction.ts (set after createInteraction
 * runs, which happens before any user click).
 */
import type { DioramaContext } from "../core/context.js";
import { STATIONS, STATION_ORDER } from "../config/stations.js";
import { focusStationById } from "./interaction.js";

export interface A11yController {
  /** Focus a station by id (also used for keyboard navigation). */
  focusStation(id: string): void;
}

const STYLE_ID = "diorama-a11y-style";

const CSS = `
.diorama-a11y{
  position:relative;
  z-index:4;
  margin:12px 16px 0;
}
.diorama-a11y summary{
  cursor:pointer;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:11px;
  letter-spacing:.08em;
  text-transform:uppercase;
  color:#a8c0cf;
  width:fit-content;
  padding:6px 10px;
  border-radius:8px;
  border:1px solid rgba(52,229,229,.25);
  background:rgba(10,24,40,.88);
}
.diorama-a11y summary:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:2px;
}
.diorama-a11y[open] summary{
  border-bottom-left-radius:0;
  border-bottom-right-radius:0;
}
.diorama-a11y-intro{
  margin:8px 0 10px;
  font-size:12px;
  line-height:1.5;
  color:#a8c0cf;
  font-family:'DM Sans',system-ui,sans-serif;
}
.diorama-a11y ul{
  list-style:none;
  margin:0;
  padding:6px;
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(250px,1fr));
  gap:4px;
  border:1px solid rgba(52,229,229,.25);
  border-top:none;
  border-radius:0 0 8px 8px;
  background:rgba(10,24,40,.88);
}
.diorama-a11y button{
  display:block;
  width:100%;
  text-align:left;
  font-family:'DM Sans',system-ui,sans-serif;
  font-size:12px;
  color:#f5fbff;
  background:transparent;
  border:1px solid transparent;
  border-radius:6px;
  padding:6px 8px;
  cursor:pointer;
}
.diorama-a11y button b{
  display:block;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px;
  letter-spacing:.06em;
  margin-bottom:2px;
  font-weight:500;
}
.diorama-a11y button:hover{
  border-color:rgba(52,229,229,.35);
}
.diorama-a11y button:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:1px;
}
.diorama-a11y button.diorama-a11y-flash{
  animation:diorama-a11y-pulse 1.2s ease;
}
@keyframes diorama-a11y-pulse{
  0%,100%{background:transparent}
  25%,60%{background:rgba(52,229,229,.18)}
}
@media (prefers-reduced-motion: reduce){
  .diorama-a11y button.diorama-a11y-flash{animation-duration:2.4s}
}
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function buildA11y(ctx: DioramaContext, actions: { onFocus(id: string): void }): A11yController {
  injectStyles();

  // Preferred mount: a page-provided region; otherwise an aside at the end of
  // the diorama host's parent section so it never overlays the canvas.
  let mount = document.querySelector<HTMLElement>("[data-diorama-a11y]");
  if (!mount) {
    const host = ctx.app.canvas.parentElement;
    const aside = document.createElement("aside");
    aside.className = "diorama-a11y-aside";
    if (host?.parentElement) {
      host.parentElement.insertBefore(aside, host.nextSibling);
    } else {
      document.body.appendChild(aside);
    }
    mount = aside;
  }

  const details = document.createElement("details");
  details.className = "diorama-a11y";

  const summary = document.createElement("summary");
  summary.textContent = "Explore the trading campus";
  details.appendChild(summary);

  const intro = document.createElement("p");
  intro.className = "diorama-a11y-intro";
  intro.textContent =
    "The scene above is a visual diorama; this directory lists every station as text. " +
    "Activating a station focuses the camera on it and shows its description.";
  details.appendChild(intro);

  const list = document.createElement("ul");
  const buttons = new Map<string, HTMLButtonElement>();

  for (const id of STATION_ORDER) {
    const station = STATIONS[id];
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.stationId = id;
    const label = document.createElement("b");
    label.textContent = station.label;
    const blurb = document.createTextNode(station.blurb);
    btn.append(label, blurb);
    btn.addEventListener("click", () => {
      actions.onFocus(id);
      controller.focusStation(id);
    });
    buttons.set(id, btn);
    li.appendChild(btn);
    list.appendChild(li);
  }
  details.appendChild(list);
  mount.appendChild(details);

  const controller: A11yController = {
    focusStation(id: string): void {
      // Delegates to the interaction layer (camera + info card), then
      // surfaces the matching button for sighted keyboard users.
      focusStationById(id);
      const btn = buttons.get(id as keyof typeof STATIONS);
      if (!btn) return;
      if (!details.open) details.open = true;
      btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
      btn.classList.remove("diorama-a11y-flash");
      // Restart the CSS animation.
      void btn.offsetWidth;
      btn.classList.add("diorama-a11y-flash");
    },
  };
  return controller;
}
