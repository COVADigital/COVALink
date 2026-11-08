import { Badge } from "@/components/ui/badge";

export function ProfileStatusBadge({ isPublished, hasUnpublishedChanges }: { isPublished: boolean; hasUnpublishedChanges: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="profile-status">
      <Badge variant={isPublished ? "default" : "secondary"} data-published={isPublished}>
        {isPublished ? "Published" : "Not published"}
      </Badge>
      {isPublished && hasUnpublishedChanges && <Badge variant="outline">Unpublished changes</Badge>}
    </span>
  );
}
