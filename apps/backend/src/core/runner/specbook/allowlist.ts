export const LOCATOR_FACTORIES = [
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "getByAltText",
    "getByTitle",
    "locator",
];
export const LOCATOR_REFINERS = ["first", "last", "nth"];
export const STATIC_LOCATOR_REFINERS = [...LOCATOR_REFINERS, "filter", "and", "or"];
export const LOCATOR_ACTIONS = [
    "click",
    "dblclick",
    "fill",
    "press",
    "pressSequentially",
    "check",
    "uncheck",
    "setChecked",
    "selectOption",
    "hover",
    "focus",
    "blur",
    "clear",
    "scrollIntoViewIfNeeded",
    "waitFor",
    "dragTo",
];
export const RUNTIME_LOCATOR_ACTIONS = LOCATOR_ACTIONS.filter((action) => !["fill", "pressSequentially", "dragTo"].includes(action));
