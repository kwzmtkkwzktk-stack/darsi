// عدّاد زوار خفيف: لا يخزّن عنوان IP ولا بيانات شخصية
(function () {
  try {
    if (navigator.doNotTrack === "1") return;
    var p = location.pathname,
      pg = p === "/" || /index\.html$/.test(p) ? "home" : /section\.html$/.test(p) ? "section" : /study\.html$/.test(p) ? "study" : "";
    if (!pg) return;
    var b = JSON.stringify({ p: pg, s: new URLSearchParams(location.search).get("s") || "", ref: document.referrer || "" });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/track", new Blob([b], { type: "application/json" }));
    else fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: b, keepalive: true });
  } catch (e) {}
})();
