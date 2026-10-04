import { PDFDocument } from "pdf-lib";

/**
 * Fills an authority's own fillable PDF form and flattens it, so the page that goes out
 * is the authority's form with the values printed on it. Every named field must exist in
 * the form: a field renamed in a new revision of the form fails loudly instead of being
 * left blank.
 */
export async function fillPdfForm(template: Uint8Array, values: Record<string, string>): Promise<Buffer> {
  const doc = await PDFDocument.load(template);
  const form = doc.getForm();
  const names = new Set(form.getFields().map((f) => f.getName()));
  const missing = Object.keys(values).filter((name) => !names.has(name));
  if (missing.length) throw new Error(`The form has no field named ${missing.map((m) => `"${m}"`).join(", ")}`);
  for (const [name, value] of Object.entries(values)) {
    const field = form.getTextField(name);
    // The form's fields auto-size, which prints values huge; a long address gets smaller type.
    field.setFontSize(value.length > 50 ? 8 : 11);
    field.setText(value);
  }
  form.flatten();
  // A fixed date keeps the bytes the same for the same values.
  doc.setModificationDate(new Date(0));
  doc.setCreationDate(new Date(0));
  return Buffer.from(await doc.save());
}
