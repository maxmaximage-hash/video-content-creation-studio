export const CONTENT_ACCOUNT_VARIANTS = Object.freeze([
  Object.freeze({ id: "blogger", label: "博主号" }),
  Object.freeze({ id: "ip", label: "IP 号" }),
]);

export function projectAccountCopy(project = {}, accountRole = "blogger") {
  const variant = project.accountVariants?.[accountRole] || {};
  if (accountRole === "blogger") {
    return {
      title: variant.title ?? project.title ?? "",
      body: variant.body ?? project.body ?? "",
    };
  }
  return {
    title: variant.title ?? "",
    body: variant.body ?? "",
  };
}

export function updateProjectAccountCopy(project = {}, accountRole, patch = {}) {
  const currentVariant = project.accountVariants?.[accountRole] || {};
  const nextVariant = { ...currentVariant, ...patch };
  const next = {
    ...project,
    accountVariants: {
      ...(project.accountVariants || {}),
      [accountRole]: nextVariant,
    },
    modified: "刚刚",
  };
  if (accountRole === "blogger") {
    if (Object.hasOwn(patch, "title")) next.title = patch.title;
    if (Object.hasOwn(patch, "body")) next.body = patch.body;
  }
  return next;
}

export function projectAccountCovers(project = {}, accountRole, coverCandidates = []) {
  return coverCandidates.filter((cover) => {
    const coverRole = String(cover?.accountRole || "").toLowerCase();
    if (accountRole === "blogger") return !coverRole || coverRole === "blogger";
    return coverRole === accountRole;
  });
}

export function assignCoverAccountRole(cover, accountRole) {
  return {
    ...(typeof cover === "string" ? { src: cover } : cover),
    accountRole,
  };
}
