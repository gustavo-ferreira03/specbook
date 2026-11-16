export const sanitizeTechnicalDetails = function sanitizeTechnicalDetails(
  text: string
): string {
  return (
    text
      // oxlint-disable-next-line no-control-regex -- Control characters must be matched explicitly at this input/output boundary.
      .replaceAll(/\u001B\[[0-9;]*m/gu, "")
      .split("\n")
      .filter(
        (line) =>
          !/^\s*at(?:\s|$)/u.test(line) &&
          !/^\s*>?\s*\d+\s*\|/u.test(line) &&
          !/^\s*(?:\|\s*)?\^+\s*$/u.test(line) &&
          !/(?:src[\\/]core[\\/]runner|apps[\\/]backend[\\/]src|node_modules)/u.test(
            line
          )
      )
      .map((line) =>
        line
          .replaceAll(
            /https?:\/\/[^\s"'`<>)]*|(?:file:\/\/)?(?:\b[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|app|workspace|root|mnt|opt|srv|storage|code|build|data)\/)[^\s"'`<>)]*/gu,
            (value) => (/^https?:\/\//u.test(value) ? value : "[server path]")
          )
          .replaceAll(
            /(?:\.\.[\\/])+(?:src|storage)[^\s"'`<>)]*/gu,
            "[server path]"
          )
      )
      .join("\n")
      .replaceAll(/\n{3,}/gu, "\n\n")
      .trim()
      .slice(0, 16_000)
  );
};
