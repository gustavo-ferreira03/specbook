export const LogoMark = function LogoMark({
  className = "size-7",
  inverse = false,
}: {
  className?: string;
  inverse?: boolean;
}) {
  return (
    /* oxlint-disable next/no-img-element -- Evidence URLs and CSS-sized SVG icons must load directly without an image optimization proxy. */
    <img
      src={inverse ? "/specbook-chat-icon.svg" : "/specbook-logo.svg"}
      alt=""
      aria-hidden="true"
      className={`select-none ${className}`}
      draggable={false}
    />
    /* oxlint-enable next/no-img-element */
  );
};

export const Brand = function Brand({ large = false }: { large?: boolean }) {
  return (
    <span
      className={`text-ink flex items-center ${large ? "gap-2" : "gap-1.5"}`}
    >
      <LogoMark className={`${large ? "size-10" : "size-7"} dark:invert`} />
      <span className={large ? "wordmark wordmark-lg" : "wordmark"}>
        specbook
      </span>
    </span>
  );
};
