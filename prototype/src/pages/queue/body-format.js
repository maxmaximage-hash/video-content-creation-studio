export function formatBodyText(value = "") {
  const normalized = String(value).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/^> ?/, "").replace(/[ \t]+$/g, ""));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

export function bodyFormatChanged(value = "") {
  return formatBodyText(value) !== String(value).replace(/\r\n?/g, "\n");
}
