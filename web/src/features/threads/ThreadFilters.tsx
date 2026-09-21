import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import FormLabel from "@mui/material/FormLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import type { LabelVariant } from "../../data/compose";
import { useLoadedData } from "../../data/DataContext";
import { ASPECT_FILTER_IDS, STYLE_FILTER_IDS } from "../../params/params";
import type { RoleFilter, ViewParams } from "../../params/params";
import { labelName, ROLE_LABELS } from "./labels";

const VARIANT_OPTIONS: readonly [LabelVariant, string][] = [
  ["parent-only", "親コメントだけ(parent-only)"],
  ["with-replies", "返信も含む(with-replies)"],
];

type Props = { params: ViewParams; update: (patch: Partial<ViewParams>) => void };

/** 選択の切り替え。並びは定義順に正規化する(同じ選択は、同じURLになる)。 */
function toggled(all: readonly string[], current: readonly string[], id: string): string[] {
  const set = new Set(current);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return all.filter((x) => set.has(x));
}

function CheckGroup(props: {
  legend: string;
  all: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <FormLabel component="legend" id={`legend-${props.legend}`}>
        {props.legend}
      </FormLabel>
      <FormGroup row role="group" aria-labelledby={`legend-${props.legend}`}>
        {props.all.map((id) => (
          <FormControlLabel
            key={id}
            label={labelName(id)}
            control={
              <Checkbox
                size="small"
                name={id}
                checked={props.selected.includes(id)}
                onChange={() => props.onChange(toggled(props.all, props.selected, id))}
              />
            }
          />
        ))}
      </FormGroup>
    </div>
  );
}

/** 絞り込み。観点(複数)が主役で、いちばん上に置く。状態はURLのクエリ(useViewParams)。 */
export function ThreadFilters({ params, update }: Props) {
  const { manifest } = useLoadedData();
  // with-replies のrun(完了したもの)があるときだけ、切り替えを出す
  const hasWithReplies = manifest.runs.some((r) => r.status === "complete" && r.variant === "with-replies");
  return (
    <form className="mb-4 flex flex-col gap-2" aria-label="絞り込み" onSubmit={(e) => e.preventDefault()}>
      <CheckGroup
        legend="観点"
        all={ASPECT_FILTER_IDS}
        selected={params.aspects}
        onChange={(aspects) => update({ aspects })}
      />
      <CheckGroup
        legend="言い方"
        all={STYLE_FILTER_IDS}
        selected={params.styles}
        onChange={(styles) => update({ styles })}
      />
      <div>
        <FormLabel component="legend" id="legend-role">
          親コメントの発言者
        </FormLabel>
        <RadioGroup
          row
          aria-labelledby="legend-role"
          value={params.role}
          onChange={(e) => update({ role: e.target.value as RoleFilter })}
        >
          {ROLE_LABELS.map(([value, label]) => (
            <FormControlLabel key={value} value={value} label={label} control={<Radio size="small" />} />
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <FormControlLabel
          label="除外を含む"
          control={
            <Checkbox
              size="small"
              checked={params.showExcluded}
              onChange={(e) => update({ showExcluded: e.target.checked })}
            />
          }
        />
        {hasWithReplies && (
          <TextField
            select
            size="small"
            label="ラベルの判定"
            value={params.variant}
            onChange={(e) => update({ variant: e.target.value as LabelVariant })}
            slotProps={{ select: { native: true } }}
          >
            {VARIANT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </TextField>
        )}
      </div>
    </form>
  );
}
