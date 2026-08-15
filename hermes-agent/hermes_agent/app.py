"""Minimal Flask application for the Hermes agent scaffold."""

from flask import Flask, jsonify, request


def create_app() -> Flask:
    app = Flask(__name__)

    @app.post("/analyze")
    def analyze():
        payload = request.get_json(silent=True) or {}
        event_id = payload.get("event_id")

        if not event_id:
            return jsonify({"error": "event_id is required"}), 400

        # TODO: Fetch event context, call the configured LLM, and persist ai_summary.
        return jsonify(
            {
                "event_id": event_id,
                "status": "stub",
                "ai_summary": "Analysis is not implemented yet.",
            }
        )

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7860)

