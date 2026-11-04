export function ImageUploadPlaceholder({ state }: { state: "uploading" | "error" }) {
  return (
    <span className={
      "inline-flex items-center rounded-md border px-2 py-1 text-xs " +
      (state === "uploading"
        ? "border-blue-200 bg-blue-50 text-blue-700"
        : "border-red-200 bg-red-50 text-red-700")
    }>
      {state === "uploading" ? "上传中…" : "上传失败"}
    </span>
  );
}
