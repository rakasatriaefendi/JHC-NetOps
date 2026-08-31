export function hasUnexpectedFormFields(formData: FormData, allowed: ReadonlySet<string>) {
  return [...formData.keys()].some(
    (key) => !key.startsWith("$ACTION_") && !allowed.has(key),
  );
}
