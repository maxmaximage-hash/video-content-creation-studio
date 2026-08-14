export function projectPrimaryCopy(project = {}) {
  const root = {
    title: String(project.title || ""),
    body: String(project.body || ""),
  };
  const variants = ["blogger", "ip"].map((accountRole) => ({
    title: String(project.accountVariants?.[accountRole]?.title || ""),
    body: String(project.accountVariants?.[accountRole]?.body || ""),
  }));
  const preferred = variants.find((copy) => copy.title.trim() || copy.body.trim()) || { title: "", body: "" };
  return {
    title: root.title.trim() ? root.title : preferred.title,
    body: root.body.trim() ? root.body : preferred.body,
  };
}
