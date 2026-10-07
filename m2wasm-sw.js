/* eslint-env serviceworker */
// Macaulay2Web -- WebAssembly engine, service worker side (see src/client/wasmEngine.ts).
//
// 1. Input channel. Emscripten reads stdin synchronously, so while Macaulay2
// waits for input, its worker (m2wasm-worker.js) blocks on a synchronous
// XMLHttpRequest to __m2wasm__/poll, which is held here until the page posts
// the next messages to __m2wasm__/send. Interrupt requests go the same way
// (__m2wasm__/interrupt, polled by the worker at __m2wasm__/check).
// Unlike SharedArrayBuffer/Atomics this needs no cross-origin isolation
// (COOP/COEP headers), which static hosts such as GitHub Pages cannot set.
// 2. Uploads. POST /upload (file uploads, editor autosave) is handed to the
// page running the engine, which writes the files where Macaulay2 sees them.
// Everything else goes to the network untouched.
"use strict";

const POLL_TIMEOUT = 10000; // answer idle polls with [] well before browsers give up on them
const waiting = new Map(); // session -> resolve function of the pending poll
const mailbox = new Map(); // session -> messages that arrived while no poll was pending
const interrupts = new Set(); // sessions with a pending interrupt request

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

const json = (body) =>
  new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const poll = function (session) {
  interrupts.delete(session); // Macaulay2 is idle: nothing left to interrupt
  const queued = mailbox.get(session);
  if (queued) {
    mailbox.delete(session);
    return Promise.resolve(json(queued));
  }
  return new Promise((resolve) => {
    const previous = waiting.get(session);
    if (previous) previous([]);
    const done = (messages) => {
      clearTimeout(timeout);
      if (waiting.get(session) === done) waiting.delete(session);
      resolve(json(messages));
    };
    const timeout = setTimeout(() => done([]), POLL_TIMEOUT);
    waiting.set(session, done);
  });
};

const send = async function (session, request) {
  const messages = await request.json();
  const done = waiting.get(session);
  if (done) done(messages);
  else mailbox.set(session, (mailbox.get(session) || []).concat(messages));
  return json(true);
};

// ask a page; it first acknowledges ({handled: false} if it has no engine), then answers
const ask = (client, msg) =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    let timeout = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timeout);
      if (e.data && e.data.pending)
        timeout = setTimeout(() => resolve(null), 120000);
      else resolve(e.data);
    };
    client.postMessage(msg, [channel.port2]);
  });

const upload = async function (event) {
  const request = event.request.clone(); // in case no page handles it
  const client = event.clientId && (await self.clients.get(event.clientId));
  if (client) {
    const fields = {},
      files = [];
    for (const [key, value] of await event.request.formData())
      if (typeof value == "string") fields[key] = value;
      else files.push({ name: value.name, data: await value.arrayBuffer() });
    const reply = await ask(client, { type: "m2wasm-upload", fields, files });
    if (reply && reply.handled !== false)
      return new Response(reply.text || "", {
        status: reply.status || 200,
        headers: { "Content-Type": "text/html" },
      });
  }
  return fetch(request);
};

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const m = /\/__m2wasm__\/(\w+)$/.exec(url.pathname);
  if (m) {
    const session = url.searchParams.get("session") || "";
    const action = m[1];
    if (action == "poll") event.respondWith(poll(session));
    else if (action == "send") event.respondWith(send(session, event.request));
    else if (action == "interrupt") {
      interrupts.add(session);
      event.respondWith(json(true));
    } else if (action == "check")
      event.respondWith(json(interrupts.delete(session)));
  } else if (
    event.request.method == "POST" &&
    /\/upload\/?$/.test(url.pathname)
  )
    event.respondWith(upload(event));
});
