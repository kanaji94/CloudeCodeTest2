import base64
import io
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

import anthropic
import pypdfium2 as pdfium

app = Flask(__name__, static_folder="static", static_url_path="")

MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")
MAX_PDF_PAGES = 5
MAX_TOTAL_IMAGES = 8

DOC_TYPE_LABELS = {
    "rfq": "客先からの見積依頼書",
    "customer_order": "客先からの注文書",
    "supplier_quote": "仕入先からの見積書",
    "drawing": "金属加工部品の図面",
}

EXTRACTION_TOOL = {
    "name": "extract_document_data",
    "description": "アップロードされた書類の画像から、見積・受発注業務に必要な項目を抽出する。",
    "input_schema": {
        "type": "object",
        "properties": {
            "detected_doc_type": {
                "type": "string",
                "description": "画像から判断した書類種別の簡潔な説明（例: 見積依頼書, 注文書, 見積書, 図面）。",
            },
            "header": {
                "type": "object",
                "description": "書類全体に関わるヘッダー情報。読み取れない項目は空文字列にする。",
                "properties": {
                    "partner_name": {"type": "string", "description": "取引先（客先または仕入先）の会社名"},
                    "partner_contact": {"type": "string", "description": "取引先の担当者名"},
                    "document_number": {"type": "string", "description": "見積番号・注文番号・依頼番号・図面番号など書類固有の番号"},
                    "issue_date": {"type": "string", "description": "発行日"},
                    "due_date": {"type": "string", "description": "回答期限・希望納期など"},
                    "validity_date": {"type": "string", "description": "見積有効期限"},
                    "payment_terms": {"type": "string", "description": "支払条件"},
                    "currency": {"type": "string", "description": "通貨（円など）"},
                    "remarks": {"type": "string", "description": "その他ヘッダーレベルの備考"},
                },
                "required": [
                    "partner_name",
                    "partner_contact",
                    "document_number",
                    "issue_date",
                    "due_date",
                    "validity_date",
                    "payment_terms",
                    "currency",
                    "remarks",
                ],
            },
            "items": {
                "type": "array",
                "description": "部品・品目ごとの明細。図面の場合はその部品1件を1要素として入れる。読み取れない項目は空文字列にする。",
                "items": {
                    "type": "object",
                    "properties": {
                        "part_no": {"type": "string", "description": "品番"},
                        "part_name": {"type": "string", "description": "品名"},
                        "material": {"type": "string", "description": "材質"},
                        "drawing_no": {"type": "string", "description": "図面番号"},
                        "revision": {"type": "string", "description": "図面改訂番号"},
                        "quantity": {"type": "string", "description": "数量（単位を含めず数値のみを文字列で）"},
                        "unit": {"type": "string", "description": "単位（個、本など）"},
                        "unit_price": {"type": "string", "description": "単価（数値のみを文字列で、通貨記号やカンマは含めない）"},
                        "amount": {"type": "string", "description": "金額（数値のみを文字列で）"},
                        "delivery_date": {"type": "string", "description": "この品目の納期"},
                        "surface_treatment": {"type": "string", "description": "表面処理（図面の場合）"},
                        "tolerance": {"type": "string", "description": "一般公差など（図面の場合）"},
                        "remarks": {"type": "string", "description": "品目に関する備考"},
                    },
                    "required": [
                        "part_no",
                        "part_name",
                        "material",
                        "drawing_no",
                        "revision",
                        "quantity",
                        "unit",
                        "unit_price",
                        "amount",
                        "delivery_date",
                        "surface_treatment",
                        "tolerance",
                        "remarks",
                    ],
                },
            },
            "overall_notes": {
                "type": "string",
                "description": "読み取りに自信がない箇所や、手書き修正・判読不能な部分があれば説明する。なければ空文字列。",
            },
        },
        "required": ["detected_doc_type", "header", "items", "overall_notes"],
    },
}

SYSTEM_PROMPT = """あなたは金属加工部品の商流（見積・受発注）に関する書類を読み取る専門アシスタントです。
添付される画像は、客先からの見積依頼書・注文書、仕入先からの見積書、または金属加工部品の図面のいずれかです。
画像が複数枚ある場合は同一書類の複数ページ、または図面の複数の図として扱い、内容を統合して1つの結果にまとめてください。
表形式の明細（品番・品名・数量・単価など）がある場合は、行を省略せずすべて items に含めてください。
数値項目（quantity, unit_price, amount）はカンマや通貨記号を除いた数値のみを文字列として入れてください。
読み取れない・記載がない項目は空文字列にしてください。推測で埋めないでください。
必ず extract_document_data ツールを呼び出して結果を返してください。"""


def pdf_to_images(data: bytes) -> list[bytes]:
    pdf = pdfium.PdfDocument(data)
    images = []
    page_count = min(len(pdf), MAX_PDF_PAGES)
    for i in range(page_count):
        page = pdf[i]
        bitmap = page.render(scale=2.0)
        pil_image = bitmap.to_pil()
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        images.append(buf.getvalue())
    return images


def build_image_blocks(images: list[bytes]) -> list[dict]:
    blocks = []
    for idx, img_bytes in enumerate(images):
        if len(images) > 1:
            blocks.append({"type": "text", "text": f"[{idx + 1}ページ目]"})
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(img_bytes).decode("ascii"),
                },
            }
        )
    return blocks


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/extract", methods=["POST"])
def extract():
    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "ファイルが指定されていません。"}), 400

    doc_type = request.form.get("doc_type", "")
    if doc_type not in DOC_TYPE_LABELS:
        return jsonify({"error": "書類種別が不正です。"}), 400

    filenames = []
    images: list[bytes] = []
    for file in files:
        filename = file.filename or ""
        data = file.read()
        if not data:
            continue
        filenames.append(filename)
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        try:
            if ext == "pdf" or data[:4] == b"%PDF":
                images.extend(pdf_to_images(data))
            elif ext in {"jpg", "jpeg", "png", "webp"} or ext == "":
                images.append(data)
            else:
                return jsonify({"error": f"対応していないファイル形式です（{filename}）。PDF, JPG, PNG, WEBP のみ対応です。"}), 400
        except Exception as exc:
            return jsonify({"error": f"ファイルの読み込みに失敗しました（{filename}）: {exc}"}), 400

    if not images:
        return jsonify({"error": "有効な画像を読み取れませんでした。"}), 400

    images = images[:MAX_TOTAL_IMAGES]

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify({"error": "サーバーに ANTHROPIC_API_KEY が設定されていません。.env を確認してください。"}), 500

    client = anthropic.Anthropic()

    content = build_image_blocks(images)
    content.append(
        {
            "type": "text",
            "text": f"この書類の種別は「{DOC_TYPE_LABELS[doc_type]}」です。上記の指示に従って項目を抽出してください。",
        }
    )

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=[EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": "extract_document_data"},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIError as exc:
        return jsonify({"error": f"Claude API呼び出しに失敗しました: {exc}"}), 502

    tool_use = next((block for block in response.content if block.type == "tool_use"), None)
    if tool_use is None:
        return jsonify({"error": "抽出結果を取得できませんでした。"}), 502

    result = tool_use.input
    result["doc_type"] = doc_type
    result["source_filename"] = ", ".join(filenames)
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
