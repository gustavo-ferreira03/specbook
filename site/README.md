# Specbook site

Build the static page with Node.js, without installing dependencies:

```sh
node site/build.mjs
python3 -m http.server 4701 --directory site/dist
```

The GitHub Pages workflow uploads `site/dist`. Assets use relative paths so the page works under `/specbook/` and on a custom domain. Nothing is published by the build command.

The page uses the application's logo, Inter and JetBrains Mono fonts, monochrome colors, and 14px body text. Font licenses are included beside the local font files. It makes no analytics or third-party font requests.

## Demo assets

Screenshots and the silent recording came from the running app against the public Sauce Demo site on October 6, 2026. The check opens the sign-in page and verifies that the username field, password field and Login button are visible. Both the manual run and the run triggered by the Spec change passed. The temporary project was deleted through the API after capture.

`spec.png` and `spec-mobile.png` show the same check at desktop and phone widths. `overview.png` shows its completed run history. `demo.webm` records opening a result, the check, and its Git history; `demo.gif` is an encoded copy of that recording for README viewers. These assets contain no staged test results or generated UI mockups.

To refresh them, create a temporary demo project, run this behavior, wait for completed results, and capture the app at 1440×1000 and 390×844. Export the recording as WebM and GIF, then delete the temporary project. Keep the screenshots consistent with the current interface.
