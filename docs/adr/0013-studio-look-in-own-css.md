# 0013. Studio look in our own CSS; no UI library, no framework

Date: 2026-11-22
Status: Accepted.

## Context

The page used a hand-made retro terminal look: bold Courier everywhere, an ASCII
logo, `[ Button ]` labels, CRT scan lines, an ASCII cat as the loading
indicator and a `[####....]` text progress bar. The user named four problems:
it looks dated and is hard to read, waveform and section editing are fiddly,
progress and errors are unclear, and it is awkward on a phone. On a 390 px
screen the section table scrolled sideways, hiding the volume and skip columns,
and the steppers were 12 x 13 px.

Five looks were compared on one mock page (terminal, retro cleaned up, clean
minimal, studio, friendly app), and the user chose **Studio**: dark, each
section in its own colour, numbers in display-style fields.

Constraints: the site has no build step (0012); `segments.js` builds the section
table from native inputs and buttons with `innerHTML`, and `main.js` wires them
by event delegation on class names.

## Options considered

1. **Pico CSS.** Styles native elements, no JS, ~80 KB. First choice, until we
   found it was archived on 2026-10-04 (2.1.1 is the final release). A vendored
   copy would keep working, but the studio look overrides most of its defaults,
   so it would add a second layer of CSS for little gain.
2. **Web Awesome** (Shoelace's successor). Maintained, polished components, but
   every input becomes a web component, so the section table and its event
   delegation would be rewritten.
3. **Bootstrap 5.** Maintained and works without a build, but needs classes on
   every generated element and gives a generic look.
4. **Tailwind / daisyUI.** Needs a build step for production use.
5. **Material Web.** In maintenance mode since 2024.
6. **Music-specific UI kits** (webaudio-controls, NexusUI). Knobs and keyboards
   MusicLab does not have; both projects are inactive.
7. **React.** Runs on Pages after a build, but means a build step and a rewrite
   of roughly 1,200 lines of interface code, for a one-screen app whose
   problems are visual.
8. **Our own CSS.** One token-based stylesheet.

## Decision

Option 8. `static/styles.css` is rewritten around a `:root` token block (colours,
section colours, waveform colours, radius, fonts). One dark theme on purpose.
IBM Plex Sans and IBM Plex Mono are vendored in `static/vendor/fonts/` with
their OFL licences, so the page loads nothing from a third-party host.

Markup changes are limited to what the look needs. Element ids and the class
names that JavaScript relies on are unchanged, so event wiring did not move.
The waveform reads its bar colours from CSS variables instead of `config.js`.
On screens up to 600 px each section row becomes a card with labelled fields
and 44 px steppers.

The waveform stays our own canvas. A trial of Peaks.js (BBC, built for marking
segments on a waveform) is deferred until the restyle has been used.

## Consequences

Positive:

- No dependency that can go stale, and still no build step.
- The section table fits a phone without sideways scrolling.
- The page's look lives in one file whose palette is a dozen variables.

Negative:

- Every control's styling and accessibility is ours to maintain.
- Moving to React later means choosing a component library then; nothing here
  carries over except the tokens.
