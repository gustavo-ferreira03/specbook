const copyButton = document.querySelector("#copy-install");
const installCommand = document.querySelector("#install-command");
const copyStatus = document.querySelector("#copy-status");

copyButton?.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(installCommand.textContent);
        copyStatus.textContent = "Command copied. Paste it into your terminal.";
    } catch {
        const range = document.createRange();
        range.selectNodeContents(installCommand);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copyStatus.textContent = "Command selected. Copy it with your keyboard or browser menu.";
    }
});
