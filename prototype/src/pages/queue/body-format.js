export function formatBodyText(value = "") {
  const normalized = String(value).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line
    .replace(/^> ?/, "")
    .replace(/[ \t]+$/g, "")
    .replace(/([\u3400-\u9fff])[ \t]+(?=[，。！？；：、])/g, "$1")
    .replace(/([，。！？；：、])[ \t]+(?=[\u3400-\u9fff])/g, "$1"));
  return lines
    .join("\n")
    .replace(/\n[ \t]*\n+/g, "\n")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

export function bodyFormatChanged(value = "") {
  return formatBodyText(value) !== String(value).replace(/\r\n?/g, "\n");
}
