// "123456" -> "123 456" for easier reading. Other lengths stay as they are.
export function formatCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
