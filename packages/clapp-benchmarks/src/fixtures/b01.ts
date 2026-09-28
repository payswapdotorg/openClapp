import type { BenchmarkApp } from "../types.ts";
import { BENCHMARK_SERVE_JS } from "./serve-script.ts";

/**
 * B01 — "clapp_benchmark_b01" — Aurora Studio, a static marketing/content
 * site. Four linked pages with stable titles, unique anchor inventories
 * (headings and nav labels), and a footer on every page.
 *
 * Anchor discipline: on three of the four pages every anchor occurs exactly
 * once in the served content; the "/services" page deliberately repeats the
 * anchor "Reliability" (a section heading and a checklist item) to stress
 * parity diffing, and nothing else repeats anywhere. All links are relative
 * and all styles inline: the site is fully self-contained and network-free.
 */

const FOOTER = "Aurora Studio | Hand-forged pages | No trackers | No external fonts";

const STYLE = `  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0 auto; max-width: 42rem; padding: 2rem 1rem 3rem; color: #222222; background: #fafaf7; line-height: 1.6; }
    nav a { margin-right: 1.25rem; text-decoration: none; color: #555555; }
    nav a:hover, nav a:focus { color: #111111; text-decoration: underline; }
    footer { margin-top: 3rem; border-top: 1px solid #dddddd; padding-top: 1rem; font-size: 0.9rem; color: #777777; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.3rem; margin-top: 2.25rem; }
    h3 { font-size: 1.05rem; margin-top: 1.75rem; }
    ul, ol { padding-left: 1.35rem; }
    li { margin: 0.45rem 0; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #cccccc; padding: 0.45rem 0.75rem; text-align: left; }
    address { font-style: normal; line-height: 1.8; }
  </style>`;

const NAV = `  <nav aria-label="Primary">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/services">Services</a>
    <a href="/contact">Contact</a>
  </nav>`;

const FOOTER_BLOCK = `  <footer>
    <p>${FOOTER}</p>
  </footer>`;

const ABOUT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aurora Studio — The Workshop</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>We are Aurora Studio</h1>
    <p>Aurora Studio is a two-person workshop in the harbor district. We design and build small web experiences for people whose name is on the door: instrument makers, letterpress printers, one-room archives, family bakeries.</p>
    <h2>Our principles</h2>
    <h3>Small, sharp, durable</h3>
    <p>Every page we ship fits in one sitting and reads in one breath. We would rather maintain four perfect pages than forty forgettable ones.</p>
    <h3>Static where possible</h3>
    <p>A page that needs no script at start time cannot fail at start time. We reach for plain markup first and reach further only when the work demands it.</p>
    <h3>Own your words</h3>
    <p>Your content lives in files you can read with any editor and host anywhere. Nothing about an Aurora page is a rental.</p>
    <h2>The long version</h2>
    <p>The studio opened after a decade of maintaining other people's over-built sites. We kept a notebook of every page that survived ten years of redesigns, and every survivor shared three traits: it was small, it was legible, and it respected the reader's bandwidth. Aurora Studio is that notebook turned into a practice.</p>
    <p>Today we take on eight to ten engagements a year. Each one starts the same way: a walk through your workshop, a stack of index cards, and the question "what must this page say?"</p>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

const CONTACT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aurora Studio — Say Hello</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>Get in touch</h1>
    <p>We reply to every message within two working days, usually sooner. Letters and postcards get pinned to the studio wall.</p>
    <h2>Studio hours</h2>
    <table>
      <caption>Weekly opening hours</caption>
      <thead>
        <tr><th scope="col">Day</th><th scope="col">Hours</th></tr>
      </thead>
      <tbody>
        <tr><td>Monday to Thursday</td><td>09:00 to 17:00</td></tr>
        <tr><td>Friday</td><td>09:00 to 13:00</td></tr>
        <tr><td>Saturday and Sunday</td><td>Closed (letterpress day)</td></tr>
      </tbody>
    </table>
    <h2>Write to us</h2>
    <address>
      Aurora Studio<br>
      Harborfront Workshops, Unit 4<br>
      12 Quay Passage<br>
      <br>
      Post: letters via the quay postbox, collected at noon<br>
      Visits: by appointment, knock twice
    </address>
    <p>Tell us your name, your workshop and one page you admire. That is enough to start.</p>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

const INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aurora Studio — Welcome</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>Digital craft with a human touch</h1>
    <p>Aurora Studio designs and builds small, durable web experiences for workshops, studios and independent makers. Every page is hand-forged, self-contained and free of external dependencies.</p>
    <h2>What we build</h2>
    <ul>
      <li>Marketing sites that load instantly and read clearly.</li>
      <li>Content pages built to survive a decade of redesigns.</li>
      <li>Print-inspired layouts with honest, static markup.</li>
    </ul>
    <h2>How we work</h2>
    <p>One designer, one engineer, one conversation at a time. We start from your words, sketch in plain HTML, and refine until the page says exactly what you mean and nothing else.</p>
    <ol>
      <li>A walk through your workshop and a stack of index cards.</li>
      <li>A single static page you can read in one breath.</li>
      <li>A handoff of files you own outright, hosted anywhere.</li>
    </ol>
    <p>New engagements open each season. The studio takes eight to ten projects a year, so every one gets the maker's full attention.</p>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

const SERVICES_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aurora Studio — What We Do</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>What we do, priced plainly</h1>
    <p>Three offerings, one page of prices, no retainers you cannot exit. Every engagement ends with files you own.</p>
    <h2>Design systems</h2>
    <p>A compact set of typographic scales, spacing rules and component patterns tailored to your workshop, delivered as a readable style sheet and a two-page specimen.</p>
    <h2>Interface engineering</h2>
    <p>Hand-built pages with progressive enhancement: the content arrives as markup, the flourishes arrive as optional script, and neither waits on the other.</p>
    <h2>Reliability</h2>
    <p>Every Aurora page ships with a maintenance card: what the page depends on, what it deliberately avoids, and the three checks to run after any edit. A page you can explain is a page you can keep.</p>
    <h3>What every engagement includes</h3>
    <ul>
      <li>Reliability — the maintenance card and its three post-edit checks.</li>
      <li>Legibility — a reading pass against a printed proof.</li>
      <li>Ownership — complete sources, no build chain you did not choose.</li>
      <li>Closure — a final walkthrough with the people who will edit it.</li>
    </ul>
    <table>
      <caption>Engagement rates</caption>
      <thead>
        <tr><th scope="col">Offering</th><th scope="col">Shape</th><th scope="col">Rate</th></tr>
      </thead>
      <tbody>
        <tr><td>Design system</td><td>Two weeks</td><td>Fixed fee</td></tr>
        <tr><td>Per-page build</td><td>Per page</td><td>Fixed fee</td></tr>
        <tr><td>Maintenance review</td><td>One day</td><td>Day rate</td></tr>
      </tbody>
    </table>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

/** B01 — the static marketing/content site (Aurora Studio). */
export const B01: BenchmarkApp = {
  id: "clapp_benchmark_b01",
  name: "Aurora Studio marketing site",
  version: "1.0.0",
  kind: "static",
  files: [
    { path: "about.html", content: ABOUT_PAGE },
    { path: "contact.html", content: CONTACT_PAGE },
    { path: "index.html", content: INDEX_PAGE },
    { path: "serve.js", content: BENCHMARK_SERVE_JS },
    { path: "services.html", content: SERVICES_PAGE },
  ],
  routes: [
    {
      path: "/",
      anchors: [
        "Home",
        "About",
        "Services",
        "Contact",
        "Digital craft with a human touch",
        "What we build",
        "How we work",
        FOOTER,
      ],
    },
    {
      path: "/about",
      anchors: [
        "Home",
        "About",
        "Services",
        "Contact",
        "We are Aurora Studio",
        "Our principles",
        "Small, sharp, durable",
        "Static where possible",
        "Own your words",
        "The long version",
        FOOTER,
      ],
    },
    {
      path: "/contact",
      anchors: [
        "Home",
        "About",
        "Services",
        "Contact",
        "Get in touch",
        "Studio hours",
        "Write to us",
        FOOTER,
      ],
    },
    {
      path: "/services",
      anchors: [
        "Home",
        "About",
        "Services",
        "Contact",
        "What we do, priced plainly",
        "Design systems",
        "Interface engineering",
        "Reliability",
        "What every engagement includes",
        FOOTER,
      ],
    },
  ],
  startCommand: "node serve.js",
  assumptions: [
    "All pages are static HTML with inline styles; no scripts execute at start time.",
    "Navigation and footer links are relative paths only; no external resources are referenced.",
    'The "/services" page deliberately repeats the anchor "Reliability" (section heading and checklist item) to stress parity diffing; every other anchor occurs exactly once on its page.',
    "serve.js hosts every sibling .html file at its derived route; the file is byte-identical to the B02 host.",
  ],
};
