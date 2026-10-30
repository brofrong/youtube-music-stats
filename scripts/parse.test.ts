import { describe, expect, test } from "bun:test";
import { merge, overlap, parseHtml, parseHtmlTime, parseJson, tokenFor, type Entry } from "./parse.ts";

const htmlCell = (video: string, title: string, channel: string, when: string) =>
  `<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">` +
  `<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube Music<br></p></div>` +
  `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched\xa0<a href="https://music.youtube.com/watch?v=${video}">${title}</a><br>` +
  `<a href="https://www.youtube.com/channel/UC123">${channel}</a><br>${when}<br></div></div></div>`;

describe("parseHtmlTime", () => {
  test("converts the Takeout local time to UTC", () => {
    expect(parseHtmlTime("Aug 24, 2026, 2:48:07 PM MSK")).toBe("2026-08-24T11:48:07");
    expect(parseHtmlTime("Aug 24, 2026, 2:48:07 PM GMT+03:00")).toBe("2026-08-24T11:48:07");
    expect(parseHtmlTime("Jan 1, 2026, 12:30:00 AM CET")).toBe("2025-12-31T23:30:00");
    expect(parseHtmlTime("Jan 1, 2026, 12:30:00 PM UTC")).toBe("2026-01-01T12:30:00");
  });

  test("fails loudly on unknown timezones instead of guessing", () => {
    expect(() => parseHtmlTime("Aug 24, 2026, 2:48:07 PM XYZT")).toThrow(/Unknown timezone/);
  });
});

describe("HTML and JSON produce identical entries", () => {
  // First listen in site/data.json: 2023-08-02T15:07:55 UTC (= 6:07:55 PM MSK)
  const html = htmlCell("33hVOJdVw8E", "Avalanche", "Bring Me The Horizon - Topic", "Aug 2, 2023, 6:07:55 PM MSK");
  const json = JSON.stringify([
    {
      header: "YouTube Music",
      title: "Watched Avalanche",
      titleUrl: "https://music.youtube.com/watch?v=33hVOJdVw8E",
      subtitles: [{ name: "Bring Me The Horizon - Topic", url: "https://www.youtube.com/channel/UC123" }],
      time: "2023-08-02T15:07:55.738Z",
    },
    { header: "YouTube", title: "Watched some video", time: "2023-08-02T15:00:00.000Z" },
  ]);

  test("same token as the stored data", () => {
    const expected: Entry = {
      title: "Avalanche",
      artist: "Bring Me The Horizon",
      date: "2023-08-02",
      ts: "2023-08-02T15:07:55",
      video: "33hVOJdVw8E",
    };
    expect(parseHtml(html)).toEqual([expected]);
    expect(parseJson(json)).toEqual([expected]);
  });

  test("unescapes HTML entities once", () => {
    const [e] = parseHtml(htmlCell("abcdefg", "Rock &amp;amp; Roll &#39;99", "AC&amp;DC", "Aug 2, 2023, 6:07:55 PM MSK"));
    expect(e?.title).toBe("Rock &amp; Roll '99");
    expect(e?.artist).toBe("AC&DC");
  });
});

describe("merge / overlap", () => {
  const e = (ts: string, video = "vid" + ts): Entry => ({ title: "t", artist: "a", date: ts.slice(0, 10), ts, video });
  const existing = [e("2026-01-01T10:00:00"), e("2026-01-02T10:00:00")];

  test("adds only unseen listens, sorted", () => {
    const { entries, added } = merge(existing, [e("2026-01-03T10:00:00"), e("2026-01-01T10:00:00"), e("2025-12-31T10:00:00")]);
    expect(added).toBe(2);
    expect(entries.map(x => x.ts)).toEqual([
      "2025-12-31T10:00:00", "2026-01-01T10:00:00", "2026-01-02T10:00:00", "2026-01-03T10:00:00",
    ]);
  });

  test("detects timestamps shifted against existing data", () => {
    const shifted = existing.map(x => ({ ...x, ts: x.ts.replace("T10", "T13") }));
    expect(overlap(existing, shifted)).toEqual({ inRange: 1, matched: 0 });
    expect(overlap(existing, existing)).toEqual({ inRange: 2, matched: 2 });
  });

  test("token falls back to title/artist when there is no video id", () => {
    expect(tokenFor({ title: "t", artist: "a", date: "2026-01-01", ts: "2026-01-01T00:00:00", video: "" }))
      .toBe("t|a|2026-01-01T00:00:00");
  });
});
