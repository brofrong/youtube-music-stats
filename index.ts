Bun.serve({
  routes: {
    "/": () => new Response(Bun.file("site/index.html")),
    "/data.json": () => new Response(Bun.file("site/data.json"), { headers: { "Content-Type": "application/json" } }),
  },
  development: { hmr: true, console: true },
});
console.log("Dev server: http://localhost:3000");
