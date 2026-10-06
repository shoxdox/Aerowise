from pathlib import Path
import re
from html import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFontFamily("DejaVu",normal="DejaVu",bold="DejaVu-Bold")
source=Path('docs/PILOT-CALL-SHEET.md').read_text()
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='Copy',fontName='DejaVu',fontSize=10,leading=14,spaceAfter=9,textColor=HexColor('#23322d')))
styles['Heading1'].keepWithNext=True; styles['Heading2'].keepWithNext=True
styles['Heading1'].fontName='DejaVu-Bold'; styles['Heading2'].fontName='DejaVu-Bold'
styles['Heading1'].textColor=HexColor('#235746'); styles['Heading1'].fontSize=19; styles['Heading1'].leading=23
styles['Heading2'].textColor=HexColor('#235746'); styles['Heading2'].fontSize=12; styles['Heading2'].leading=16
flow=[]
def fmt(s):
 s=s.replace('—','-').replace('–','-').replace('“','"').replace('”','"').replace('’',"'")
 s=re.sub(r'\[([^]]+)\]\(([^)]+)\)',r'\1 (\2)',s)
 s=escape(s); s=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',s); return s
flow.append(Paragraph('STAGING WALKTHROUGH • OCTOBER 6, 2026'.replace('•','/'),styles['Copy']))
flow.append(Paragraph('Manual printable worksheet. The app currently has no PDF generator. No authority has been contacted. Contact details and dated sources must be checked before use.',styles['Copy']))
for block in source.split('\n\n'):
 if not block.strip(): continue
 if block.startswith('# '): flow.append(Paragraph(fmt(block[2:]),styles['Heading1']))
 elif block.startswith('## '): flow.append(Paragraph(fmt(block[3:]),styles['Heading2']))
 else:
  for line in (block.splitlines() if block.startswith('- ') or re.match(r'\d\.',block) else [' '.join(block.splitlines())]):
   flow.append(Paragraph(fmt(line),styles['Copy']))
def footer(c,d):
 c.setStrokeColor(HexColor('#cbd8d0'));c.line(42,37,570,37)
 c.setFont('DejaVu',8);c.setFillColor(HexColor('#52665b'));c.drawString(42,25,'Aerowise / prepared worksheet / no contact made');c.drawRightString(570,25,str(d.page))
SimpleDocTemplate('output/pdf/aerowise-pilot-call-sheet.pdf',pagesize=(612,792),rightMargin=42,leftMargin=42,topMargin=38,bottomMargin=50,title='Aerowise pilot call sheet - staging walkthrough',author='Aerowise').build(flow,onFirstPage=footer,onLaterPages=footer)
