const $ = s => document.querySelector(s);
const id = new URLSearchParams(location.search).get("id");
let info, sent = false;

function send(answer) {
  if (sent) return;
  sent = true;
  chrome.runtime.sendMessage({ type: "ask:answer", id, ...answer });
}

const template = () => $("#name").value.trim();

function refresh() {
  const ctx = { ...info.ctx, date: new Date(info.ctx.date) };
  const typed = template() || info.proposedBase;
  $("#final").textContent = render({ template: typed, appendExt: info.appendExt }, ctx, { groups: info.groups }, info.counter);
}

(async () => {
  info = await chrome.runtime.sendMessage({ type: "ask:get", id });
  if (!info) { window.close(); return; }

  $("#rule").textContent = `Règle « ${info.rule} »`;
  $("#from").textContent = `${info.ctx.filename}${info.ctx.domain ? " — " + info.ctx.domain : ""}`;
  $("#ext").textContent = info.appendExt && info.ctx.ext ? "." + info.ctx.ext : "";
  $("#name").value = info.proposedBase;
  for (const v of info.suggestions || []) {
    const o = document.createElement("option");
    o.value = v;
    $("#sugg").appendChild(o);
  }
  $("#key").value = guessKey(info.ctx.name);
  $("#key").disabled = true;
  $("#name").focus();
  $("#name").select();
  refresh();
})();

$("#name").addEventListener("input", refresh);
$("#name").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("#ok").click(); }
});
$("#key").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("#ok").click(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { send({ action: "proposed" }); }
});

$("#remember").onchange = e => { $("#key").disabled = !e.target.checked; if (e.target.checked) $("#key").select(); };
$("#ok").onclick = () => send({
  action: "ok", name: template(),
  remember: $("#remember").checked, key: $("#key").value.trim()
});
$("#orig").onclick = () => send({ action: "original" });
$("#cancel").onclick = () => send({ action: "cancel" });

// Garde le service worker éveillé tant que la fenêtre est ouverte.
setInterval(() => chrome.runtime.sendMessage({ type: "ask:ping" }).catch(() => {}), 20000);
