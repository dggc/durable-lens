// Progressive enhancement: a button that copies the command. Without it the command is still selectable text.
const button = document.querySelector("button.copy");
const status = document.getElementById("copy-status");

if (button && status && navigator.clipboard) {
	button.hidden = false;
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(button.dataset.copy ?? "");
			button.textContent = "Copied";
			status.textContent = "Command copied to the clipboard";
		} catch {
			button.textContent = "Copy failed";
			status.textContent = "Could not copy the command";
		}
		setTimeout(() => {
			button.textContent = "Copy";
			status.textContent = "";
		}, 2000);
	});
}
