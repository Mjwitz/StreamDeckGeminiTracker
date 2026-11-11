import os
import math
from PIL import Image, ImageDraw, ImageFont

def ensure_dir(path):
    os.makedirs(path, exist_ok=True)

def draw_antigravity_gemini_logo(draw, center, size, color_primary, color_secondary):
    """Draws a beautiful stylized 4-pointed Gemini / Antigravity sparkle."""
    cx, cy = center
    r_outer = size * 0.46
    r_inner = size * 0.12

    points = []
    num_points = 8  # 4 main points, 4 inner valleys
    for i in range(num_points):
        angle = i * (2 * math.pi / num_points) - math.pi / 2
        r = r_outer if (i % 2 == 0) else r_inner
        x = cx + r * math.cos(angle)
        y = cy + r * math.sin(angle)
        points.append((x, y))

    draw.polygon(points, fill=color_primary)
    
    # Inner accent sparkle
    accent_points = []
    for i in range(num_points):
        angle = i * (2 * math.pi / num_points) - math.pi / 2
        r = (r_outer * 0.45) if (i % 2 == 0) else (r_inner * 0.4)
        x = cx + r * math.cos(angle)
        y = cy + r * math.sin(angle)
        accent_points.append((x, y))
    draw.polygon(accent_points, fill=color_secondary)

def create_image(width, height, draw_func):
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_func(draw, width, height)
    return img

def main():
    base_dir = "com.mjwitz.gemini-tracker.sdPlugin/imgs"
    plugin_dir = os.path.join(base_dir, "plugin")
    actions_dir = os.path.join(base_dir, "actions")
    
    ensure_dir(plugin_dir)
    
    # 1. Plugin Marketplace Icons (288x288 and 512x512)
    def draw_marketplace(draw, w, h):
        # Dark tech gradient background
        bg_color = (13, 17, 23, 255)
        draw.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(w * 0.2), fill=bg_color)
        
        # Outer ring
        draw.arc([w * 0.08, h * 0.08, w * 0.92, h * 0.92], start=135, end=405, fill=(56, 189, 248, 180), width=int(w * 0.04))
        draw.arc([w * 0.12, h * 0.12, w * 0.88, h * 0.88], start=210, end=350, fill=(168, 85, 247, 220), width=int(w * 0.03))
        
        # Center Gemini / Antigravity star
        draw_antigravity_gemini_logo(draw, (w / 2, h / 2), w * 0.7, (56, 189, 248, 255), (255, 255, 255, 255))
        
        # Bottom indicator dot
        r_dot = w * 0.035
        draw.ellipse([w * 0.5 - r_dot, h * 0.82 - r_dot, w * 0.5 + r_dot, h * 0.82 + r_dot], fill=(16, 185, 129, 255))

    img_mp = create_image(288, 288, draw_marketplace)
    img_mp.save(os.path.join(plugin_dir, "marketplace.png"))
    
    img_mp_2x = create_image(512, 512, draw_marketplace)
    img_mp_2x.save(os.path.join(plugin_dir, "marketplace@2x.png"))

    # 2. Category Icons (28x28 and 56x56, monochromatic white on transparent)
    def draw_category(draw, w, h):
        draw_antigravity_gemini_logo(draw, (w / 2, h / 2), w * 0.9, (255, 255, 255, 255), (255, 255, 255, 128))

    img_cat = create_image(28, 28, draw_category)
    img_cat.save(os.path.join(plugin_dir, "category-icon.png"))
    
    img_cat_2x = create_image(56, 56, draw_category)
    img_cat_2x.save(os.path.join(plugin_dir, "category-icon@2x.png"))

    # 3. Actions Icons
    actions = [
        ("weekly", (56, 189, 248), "7D", "WEEK"),
        ("five-hour", (16, 185, 129), "5H", "5-HR"),
        ("claude-gpt", (249, 115, 22), "3P", "C/GPT"),
        ("gemini-argon", (168, 85, 247), "Ar", "ARGON"),
        ("cycle", (236, 72, 153), "↻", "CYCLE")
    ]

    for act_id, color, symbol, short_name in actions:
        act_path = os.path.join(actions_dir, act_id)
        ensure_dir(act_path)
        
        # Action List Icon (20x20 and 40x40, monochromatic white)
        def draw_action_icon(draw, w, h):
            draw.arc([w * 0.1, h * 0.1, w * 0.9, h * 0.9], start=45, end=315, fill=(255, 255, 255, 255), width=max(1, int(w * 0.12)))
            draw.ellipse([w * 0.38, h * 0.38, w * 0.62, h * 0.62], fill=(255, 255, 255, 255))
        
        create_image(20, 20, draw_action_icon).save(os.path.join(act_path, "icon.png"))
        create_image(40, 40, draw_action_icon).save(os.path.join(act_path, "icon@2x.png"))

        # Action Default Key Image (72x72 and 144x144)
        def make_draw_key(theme_color, label):
            def draw_key(draw, w, h):
                # Background
                draw.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(w * 0.16), fill=(18, 22, 34, 255))
                # Circular gauge ring
                draw.arc([w * 0.12, h * 0.12, w * 0.88, h * 0.88], start=135, end=405, fill=(40, 48, 68, 255), width=int(w * 0.08))
                draw.arc([w * 0.12, h * 0.12, w * 0.88, h * 0.88], start=135, end=340, fill=(*theme_color, 255), width=int(w * 0.08))
                
                # Center Sparkle / Symbol
                draw_antigravity_gemini_logo(draw, (w * 0.5, h * 0.44), w * 0.36, (*theme_color, 255), (255, 255, 255, 220))
                
                # Bottom pill
                pill_h = int(h * 0.2)
                pill_w = int(w * 0.72)
                pill_x = int((w - pill_w) / 2)
                pill_y = int(h * 0.72)
                draw.rounded_rectangle([pill_x, pill_y, pill_x + pill_w, pill_y + pill_h], radius=int(pill_h * 0.4), fill=(30, 36, 52, 230))
            return draw_key

        create_image(72, 72, make_draw_key(color, short_name)).save(os.path.join(act_path, "key.png"))
        create_image(144, 144, make_draw_key(color, short_name)).save(os.path.join(act_path, "key@2x.png"))

    print("All icons successfully generated!")

if __name__ == "__main__":
    main()
