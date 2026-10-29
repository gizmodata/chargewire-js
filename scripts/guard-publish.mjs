// npm runs this before `npm publish`. Publishing happens only from the release workflow
// (trusted publishing, gated on the full test suite), which sets CHARGEWIRE_JS_RELEASE=1.
if (process.env.CHARGEWIRE_JS_RELEASE !== "1") {
  console.error("Refusing to publish: @gizmodata/chargewire is published only by .github/workflows/release.yml.");
  process.exit(1);
}
