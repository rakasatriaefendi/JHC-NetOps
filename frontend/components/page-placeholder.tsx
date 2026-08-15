type PagePlaceholderProps = {
  title: string;
};

export function PagePlaceholder({ title }: PagePlaceholderProps) {
  return (
    <main className="p-6">
      <h1 className="text-heading font-semibold">{title}</h1>
      <p className="mt-2 text-text-secondary">
        Placeholder page. Implementation will follow the MVP roadmap.
      </p>
    </main>
  );
}

