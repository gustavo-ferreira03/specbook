export const inspectElement = function inspectElement(
  element: Element
): string {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this helper in the function body that is serialized or hardened as a unit.
  const clean = (node: Element) => {
    const copy = node.cloneNode(true) as Element;
    for (const field of [copy, ...copy.querySelectorAll("*")]) {
      field.removeAttribute("value");
      if (field.matches("input, textarea, select")) {
        field.textContent = "";
      }
    }
    return copy;
  };
  const openingTag = (node: Element) =>
    clean(node.cloneNode(false) as Element)
      .outerHTML.replace(/<\/[^>]+>$/u, "")
      .slice(0, 600);
  const ancestors: string[] = [];
  for (
    let node = element.parentElement;
    node && ancestors.length < 4;
    node = node.parentElement
  ) {
    ancestors.push(openingTag(node));
  }
  const style = getComputedStyle(element);
  return JSON.stringify({
    html: clean(element).outerHTML.slice(0, 6000),
    ancestors,
    computed: {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fill: style.fill,
      stroke: style.stroke,
    },
  });
};

export const INSPECT_ELEMENT = inspectElement.toString();

export const redactUrls = function redactUrls(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(redactUrls);
  }
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [key, redactUrls(item)])
    );
  }
  if (typeof input !== "string") {
    return input;
  }
  return input.replaceAll(/https?:\/\/[^\s"'<>]+/gu, (urlText) => {
    try {
      const url = new URL(urlText);
      url.username = "";
      url.password = "";
      for (const key of url.searchParams.keys()) {
        url.searchParams.set(key, "[redacted]");
      }
      url.hash = "";
      return url.toString();
    } catch {
      return "[invalid URL]";
    }
  });
};
