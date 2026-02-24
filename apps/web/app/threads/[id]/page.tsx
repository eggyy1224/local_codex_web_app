export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main>
      <section className="panel" data-testid="thread-detail-root">
        <h1>Thread {id}</h1>
        <p className="muted">Slice 1 placeholder detail page</p>
      </section>
    </main>
  );
}
