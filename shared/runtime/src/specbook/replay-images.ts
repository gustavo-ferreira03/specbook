interface ReplayImageMirror {
  getNode: (id: number) => Node | null;
  getId: (node: Node) => number;
}
type ImageAttributes = Record<string, unknown>;
interface SerializedImageNode {
  id?: number;
  tagName?: string;
  attributes?: ImageAttributes;
  childNodes?: SerializedImageNode[];
}
interface ImageEvent {
  type?: number;
  data?: {
    node?: SerializedImageNode;
    source?: number;
    adds?: { node: SerializedImageNode }[];
    attributes?: { id: number; attributes: ImageAttributes }[];
  };
}

// Serialized into the init script; keep its browser dependencies inside the function.
export const createReplayImageRecorder = function createReplayImageRecorder(
  deliver: (event: unknown) => void,
  mirror: ReplayImageMirror
): { process: (event: unknown) => unknown; stop: () => void } {
  const state = new WeakMap<HTMLImageElement, { key: string; data: string }>();
  const layouts = new WeakMap<HTMLImageElement, string>();
  const tracked = new Set<HTMLImageElement>();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let stopped = false;
  const images = {
    blocked(image: HTMLImageElement): boolean {
      let element: Element | null = image;
      while (element) {
        if (element.matches(".__specbookSecret, [data-specbook-secret]")) {
          return true;
        }
        const root = element.getRootNode();
        element = element.parentElement ?? ((root as ShadowRoot).host || null);
      }
      return false;
    },
    // oxlint-disable-next-line complexity -- Check image availability and encoding limits together before capturing pixels.
    encode(image: HTMLImageElement): string | undefined {
      if (
        !context ||
        images.blocked(image) ||
        !image.complete ||
        !image.naturalWidth ||
        !image.naturalHeight
      ) {
        return;
      }
      const rectangle = image.getBoundingClientRect();
      const ratio = Math.min(
        2,
        image.ownerDocument.defaultView?.devicePixelRatio || 1
      );
      const fit =
        image.ownerDocument.defaultView?.getComputedStyle(image).objectFit;
      let scale =
        rectangle.width > 0 && rectangle.height > 0
          ? (fit === "contain" || fit === "scale-down" ? Math.min : Math.max)(
              rectangle.width / image.naturalWidth,
              rectangle.height / image.naturalHeight
            )
          : 1;
      if (fit === "none") {
        scale = 1;
      }
      if (fit === "scale-down") {
        scale = Math.min(1, scale);
      }
      scale = Math.min(1, scale * ratio);
      const fill =
        fit === "fill" && rectangle.width > 0 && rectangle.height > 0;
      const width = Math.max(
        1,
        Math.min(
          image.naturalWidth,
          Math.ceil(fill ? rectangle.width * ratio : image.naturalWidth * scale)
        )
      );
      const height = Math.max(
        1,
        Math.min(
          image.naturalHeight,
          Math.ceil(
            fill ? rectangle.height * ratio : image.naturalHeight * scale
          )
        )
      );
      const key = `${image.currentSrc || image.src}:${image.naturalWidth}:${image.naturalHeight}:${width}:${height}`;
      const previous = state.get(image);
      if (previous?.key === key) {
        return previous.data;
      }
      try {
        canvas.width = width;
        canvas.height = height;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
        // Keep fine detail when the replay is enlarged.
        const data = canvas.toDataURL("image/webp", 0.92);
        if (!data.startsWith("data:image/webp;")) {
          return;
        }
        state.set(image, { key, data });
        return data;
      } catch {
        /* Cleanup is best effort; preserve the original result. */
        // An unreadable canvas leaves this image without replay data.
      }
    },
    refresh(image: HTMLImageElement): void {
      if (stopped || !image.isConnected) {
        return;
      }
      const before = state.get(image)?.data;
      const previousLayout = layouts.get(image);
      const data = images.encode(image);
      const id = mirror.getId(image);
      if (!data || id < 0) {
        return;
      }
      const attributes: ImageAttributes = {};
      images.output(image, attributes, data, true);
      if (data === before && layouts.get(image) === previousLayout) {
        return;
      }
      deliver({
        type: 3,
        timestamp: Date.now(),
        data: {
          source: 0,
          adds: [],
          removes: [],
          texts: [],
          attributes: [{ id, attributes }],
        },
      });
    },
    load(event: Event): void {
      images.refresh(event.currentTarget as HTMLImageElement);
    },
    output(
      image: HTMLImageElement,
      attributes: ImageAttributes,
      data: string,
      incremental: boolean
    ): void {
      attributes.src = data;
      attributes.rr_dataURL = data;
      if (incremental) {
        attributes.srcset = null;
      } else {
        delete attributes.srcset;
      }
      const computed = image.ownerDocument.defaultView?.getComputedStyle(image);
      if (
        !computed ||
        // oxlint-disable-next-line unicorn/prefer-number-coercion -- CSS dimensions include a px suffix, so parseFloat is required.
        !Number.parseFloat(computed.width) ||
        // oxlint-disable-next-line unicorn/prefer-number-coercion -- CSS dimensions include a px suffix, so parseFloat is required.
        !Number.parseFloat(computed.height)
      ) {
        return;
      }
      // New intrinsic image dimensions must not alter auto sizing or aspect ratios.
      const originalStyle =
        typeof attributes.style === "string"
          ? attributes.style
          : image.getAttribute("style") || "";
      const style = `${originalStyle};width:${computed.width}!important;height:${computed.height}!important`;
      attributes.style = style;
      layouts.set(image, style);
    },
    attributes(
      id: number | undefined,
      attributes: ImageAttributes | undefined,
      incremental = false
    ): void {
      if (id === undefined || !attributes) {
        return;
      }
      const node = mirror.getNode(id);
      if (!node || node.nodeType !== 1 || (node as Element).tagName !== "IMG") {
        return;
      }
      const image = node as HTMLImageElement;
      if (images.blocked(image)) {
        return;
      }
      if (!tracked.has(image)) {
        tracked.add(image);
        observer.observe(image);
        image.addEventListener("load", images.load);
      }
      const data = images.encode(image);
      if (data) {
        images.output(image, attributes, data, incremental);
      }
    },
    node(node: SerializedImageNode): void {
      if (node.tagName === "img") {
        images.attributes(node.id, node.attributes);
      }
      for (const child of node.childNodes ?? []) {
        images.node(child);
      }
    },
    prune(): void {
      for (const image of tracked) {
        if (image.isConnected) {
          continue;
        }
        observer.unobserve(image);
        image.removeEventListener("load", images.load);
        tracked.delete(image);
      }
    },
    process(event: unknown): unknown {
      const item = event as ImageEvent;
      if (item.type === 2 && item.data?.node) {
        images.prune();
        images.node(item.data.node);
      }
      if (item.type === 3 && item.data?.source === 0) {
        images.prune();
        for (const addition of item.data.adds ?? []) {
          images.node(addition.node);
        }
        for (const change of item.data.attributes ?? []) {
          images.attributes(change.id, change.attributes, true);
        }
      }
      return event;
    },
    stop(): void {
      stopped = true;
      observer.disconnect();
      for (const image of tracked) {
        image.removeEventListener("load", images.load);
      }
      tracked.clear();
    },
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      images.refresh(entry.target as HTMLImageElement);
    }
  });
  return images;
};
