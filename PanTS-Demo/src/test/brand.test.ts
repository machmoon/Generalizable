/**
 * Brand invariants — locks the BodyMaps identity assets and tokens so a
 * merge or refactor cannot silently revert them (this happened once:
 * a brand-alignment commit was undone by an unrelated upstream merge).
 * If one of these fails, see BRANDING.md at the repo root.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// cwd is PanTS-Demo because npm runs scripts from the package dir and CI
// sets working-directory accordingly (vitest itself does not chdir)
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("brand identity", () => {
  it("index.html carries the favicon set, theme color, description, and og tags", () => {
    const html = read("index.html");
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="theme-color" content="#0F172A"');
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:image"');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("the logo file is the adopted mark (two ink bars + blue band)", () => {
    const svg = read("public/bodymaps-logo.svg");
    expect(svg).toContain("#68ACE5"); // agreement band (JHU Spirit Blue)
    expect(svg).toContain("#0F172A"); // ink bars
    expect(svg).not.toContain("#27379b"); // invented navy crosshair
  });

  it("brand tokens match the brand pack", () => {
    const css = read("src/styles/brand.css");
    expect(css).toContain("--accent: #E76F51");
    expect(css).toContain("--accent-deep: #C2532F");
    expect(css).toContain("--ink: #0F172A");
    expect(css).toContain('--font-sans: "IBM Plex Sans"');
  });

  it("the viewer font seam points at the brand fonts (accent color was reverted separately)", () => {
    const css = read("src/index.css");
    expect(css).toContain("--vp-font: var(--font-sans)");
    expect(css).toContain("--vp-mono: var(--font-mono)");
  });

  it("keeps Live Rooms and Solo Challenge on the blue feature palette", () => {
    const liveRooms = read("src/liveRooms/liveRooms.css");
    const soloChallenge = read("src/education/soloChallenge.css");

    expect(liveRooms).toContain("--lr-primary: #6ea8fe");
    expect(liveRooms).not.toMatch(/#72d8e5|#c7f36b|rgba\(199,\s*243,\s*107/);
    expect(soloChallenge).toContain("--edu-primary: #6ea8fe");
    expect(soloChallenge).not.toMatch(/rgba\(231,\s*111,\s*81/);
  });
});
