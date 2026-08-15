"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";

import { setViewerAccessAction } from "@/app/actions/admin";

type ViewerAccessControlProps = {
  enabled: boolean;
  userId: string;
};

export function ViewerAccessControl({
  enabled,
  userId,
}: ViewerAccessControlProps) {
  return (
    <form action={setViewerAccessAction}>
      <input type="hidden" name="user_id" value={userId} />
      <AccessOptions initialEnabled={enabled} />
    </form>
  );
}

function AccessOptions({ initialEnabled }: { initialEnabled: boolean }) {
  const groupId = useId();
  const { pending } = useFormStatus();
  const [selected, setSelected] = useState(initialEnabled);

  function submitSelection(value: boolean, form: HTMLFormElement | null) {
    setSelected(value);
    window.requestAnimationFrame(() => form?.requestSubmit());
  }

  return (
    <fieldset disabled={pending}>
      <legend className="mb-2 text-meta font-medium text-text-secondary">
        Akses dashboard
      </legend>
      <div
        className="inline-flex rounded-control border border-border bg-bg-base p-1"
        role="radiogroup"
        aria-label="Akses dashboard viewer"
      >
        <label
          htmlFor={`${groupId}-on`}
          className={`cursor-pointer rounded-control px-3 py-1 text-meta font-medium transition-colors ${
            selected
              ? "bg-severity-low/10 text-severity-low"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <input
            id={`${groupId}-on`}
            className="sr-only"
            type="radio"
            name="enabled"
            value="true"
            checked={selected}
            onChange={(event) => submitSelection(true, event.currentTarget.form)}
          />
          ● On
        </label>
        <label
          htmlFor={`${groupId}-off`}
          className={`cursor-pointer rounded-control px-3 py-1 text-meta font-medium transition-colors ${
            !selected
              ? "bg-severity-critical/10 text-severity-critical"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <input
            id={`${groupId}-off`}
            className="sr-only"
            type="radio"
            name="enabled"
            value="false"
            checked={!selected}
            onChange={(event) => submitSelection(false, event.currentTarget.form)}
          />
          ● Off
        </label>
      </div>
      {pending ? (
        <p role="status" className="mt-2 text-meta text-text-muted">
          Menyimpan perubahan...
        </p>
      ) : null}
    </fieldset>
  );
}

