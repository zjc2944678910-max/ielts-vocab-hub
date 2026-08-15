(() => {
  if (window.location.protocol !== "file:") return;

  const route = window.location.hash || "#lookup";
  window.location.replace(`http://127.0.0.1:8080/${route}`);
})();
