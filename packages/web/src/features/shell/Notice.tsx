export function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="notice" role="alert">
      <h1 className="notice__title">{title}</h1>
      <p className="notice__body">{renderWithCode(body)}</p>
    </div>
  );
}

/** Ceviri metnindeki `backtick` parcalarini <code> olarak gosterir. */
function renderWithCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : part,
  );
}
