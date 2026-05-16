import ThreadPageClient from "./ThreadPageClient";

type Props = {
  params: Promise<{ id: string }>;
};

export default function ThreadPage({ params }: Props) {
  return <ThreadPageClient params={params} />;
}
